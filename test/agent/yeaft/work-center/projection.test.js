import { describe, expect, it } from 'vitest';
import { projectWorkCenterEvent, projectWorkItemDetail } from '../../../../agent/yeaft/work-center/projection.js';

function internalDetail() {
  return {
    id: 'wi-1', revision: 2, title: 'Fix', goal: 'Goal', status: 'waiting',
    acceptanceCriteria: ['Safe detail'], workflowTemplate: 'ai-planned',
    workflowSnapshot: { planningMode: 'ai', workItemType: 'bug-fix' },
    currentActionId: 'a-1', currentRunId: 'r-2', workDir: '/project', reuseMemory: true,
    origin: { sessionId: 's-1', messageId: 'secret-message', createdBy: 'linus' },
    linkedSessionIds: ['s-1'],
    attachments: [{
      id: 'att-1', name: 'screen.png', mimeType: 'image/png', size: 42, isImage: true,
      storageName: 'private.png', sha256: 'secret-digest',
    }],
    createdAt: 1, updatedAt: 2,
    actions: [{
      id: 'a-1', workItemId: 'wi-1', sequence: 1, type: 'review', stageId: 'review',
      assignmentPolicy: { mode: 'auto', capability: 'review', candidateVpIds: ['martin'] },
      modelPolicy: { mode: 'specific', model: 'provider/review', effort: 'high' },
      status: 'completed', createdAt: 1, updatedAt: 2,
      brief: {
        objective: 'Review the change',
        approach: 'Inspect the diff and verification evidence',
        expectedOutcome: 'An approval or actionable findings',
      },
    }],
    runs: [{
      id: 'r-2', actionId: 'a-1', workItemId: 'wi-1', status: 'waiting', startedAt: 2,
      response: 'Reviewed the change and found one compatibility decision.',
      summary: 'Review needs a compatibility choice', evidence: [{ output: 'secret latest evidence' }],
      waitingReason: 'Choose the compatibility behavior',
      error: 'Request https://user:pass@example.com/private?token=secret failed in /home/alice/private/project with api_key=top-secret',
      loopCount: 2, toolCount: 5, llmRequestCount: 3,
      inputTokens: 200, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10,
      totalTokens: 280, progressRevision: 4,
      roleSnapshot: { id: 'review', actionType: 'review', selectionReason: 'auto:review' },
      vpSnapshot: { id: 'martin', name: 'Martin', persona: 'secret persona' },
      modelSnapshot: { id: 'provider/review', provider: 'provider', effort: 'high' },
      toolPolicySnapshot: { allowedToolNames: ['FileRead'], readRoots: ['/private/read'] },
    }, {
      id: 'r-1', actionId: 'a-1', workItemId: 'wi-1', status: 'retryable', startedAt: 1,
      response: 'Earlier retry response',
      summary: 'Earlier retry summary', evidence: [{ output: 'secret earlier evidence' }],
      loopCount: 1, toolCount: 3, llmRequestCount: 2,
      inputTokens: 100, outputTokens: 25, cacheReadTokens: 10, cacheWriteTokens: 5,
      totalTokens: 140, progressRevision: 2,
    }],
    events: [{
      id: 'e-1', workItemId: 'wi-1', actionId: 'a-1', runId: 'r-1',
      type: 'run.started', data: { secret: true }, createdAt: 1,
    }],
  };
}

describe('Work Center event projection', () => {
  it('broadcasts list state plus safe live Action response and aggregate counts', () => {
    const detail = internalDetail();
    const projected = projectWorkCenterEvent({ type: 'run.finished', workItem: detail });

    expect(projected.workItem).toMatchObject({
      id: 'wi-1', status: 'waiting', workItemType: 'bug-fix', planningMode: 'ai',
    });
    expect(projected.workItem.actionStats).toEqual([{
      id: 'a-1', status: 'completed', failureReason: '',
      executionStats: {
        llmRequestCount: 5, loopCount: 3, toolCount: 8,
        inputTokens: 300, outputTokens: 75, cacheReadTokens: 30, cacheWriteTokens: 15,
        totalTokens: 420,
      },
      loopCount: 3, toolCount: 8,
      response: 'Reviewed the change and found one compatibility decision.',
      progressRevision: 4,
      messages: [{
        id: 'a-1:1', status: 'retryable', text: 'Earlier retry response', createdAt: 1, updatedAt: 1,
      }, {
        id: 'a-1:2', status: 'waiting', text: 'Reviewed the change and found one compatibility decision.', createdAt: 2, updatedAt: 2,
      }],
    }]);
    const wire = JSON.stringify(projected);
    for (const secret of [
      '/project', 'provider/review', 'Review needs a compatibility choice', 'secret latest evidence',
      'top-secret', 'user:pass', '?token=secret', '/home/alice/private/project',
      'secret-message', 'linus', 'Choose the compatibility behavior',
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it('projects user-facing Action text without Run, event, model, or evidence detail', () => {
    const projected = projectWorkItemDetail(internalDetail());

    expect(projected).toMatchObject({
      id: 'wi-1',
      waitingReason: 'Choose the compatibility behavior',
      workItemType: 'bug-fix', planningMode: 'ai',
      attachments: [{ id: 'att-1', name: 'screen.png', mimeType: 'image/png', size: 42, isImage: true }],
      executionStats: {
        llmRequestCount: 5, loopCount: 3, toolCount: 8,
        inputTokens: 300, outputTokens: 75, cacheReadTokens: 30, cacheWriteTokens: 15,
        totalTokens: 420,
      },
      actionCount: 1,
      actionSummary: 'review',
      actions: [{
        id: 'a-1', sequence: 1, type: 'review', stageId: 'review',
        assignmentPolicy: { mode: 'auto', capability: 'review', fixedVpId: null },
        status: 'completed',
        executionStats: {
          llmRequestCount: 5, loopCount: 3, toolCount: 8,
          inputTokens: 300, outputTokens: 75, cacheReadTokens: 30, cacheWriteTokens: 15,
          totalTokens: 420,
        },
        loopCount: 3, toolCount: 8,
        response: 'Reviewed the change and found one compatibility decision.',
        progressRevision: 4,
      }],
    });
    expect(projected).not.toHaveProperty('currentRunId');
    expect(projected).not.toHaveProperty('runs');
    expect(projected).not.toHaveProperty('events');
    expect(projected.actions[0]).not.toHaveProperty('modelPolicy');
    const wire = JSON.stringify(projected);
    for (const secret of [
      '/project', 'provider/review', 'Review needs a compatibility choice', 'secret latest evidence',
      'top-secret', 'user:pass', '?token=secret', '/home/alice/private/project',
      'secret persona', 'allowedToolNames', '/private/read',
      'secret-message', 'candidateVpIds', 'private.png', 'secret-digest',
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it('projects a bounded, sanitized failure reason for failed Work Item and Action detail', () => {
    const detail = internalDetail();
    detail.status = 'needs_attention';
    detail.actions[0].status = 'failed';
    detail.runs[0].status = 'failed';

    const projected = projectWorkItemDetail(detail);

    expect(projected.failureReason).toBe('The Action failed. Sensitive details were omitted.');
    expect(projected.actions[0].failureReason).toBe(projected.failureReason);
    expect(projected.actions[0].messages.at(-1)).toMatchObject({
      status: 'failed', failureReason: projected.failureReason,
    });
    expect(JSON.stringify(projected)).not.toMatch(/user:pass|token=secret|top-secret|\/home\/alice/);
  });

  it.each([
    'Provider rejected sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    'Provider rejected github_pat_11AAABBBCCCDDDEEEFFF',
    'AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz123456',
    String.raw`Failed at \\server\private\project\file.js`,
    'Failed at /home/alice/My Project/private.js',
    String.raw`Failed at C:\Users\Alice\My Project\private.js`,
  ])('fails closed when a Run error contains sensitive material: %s', error => {
    const detail = internalDetail();
    detail.status = 'needs_attention';
    detail.actions[0].status = 'failed';
    detail.runs[0] = { ...detail.runs[0], status: 'failed', error };

    const wire = JSON.stringify(projectWorkItemDetail(detail));

    expect(projectWorkItemDetail(detail).failureReason)
      .toBe('The Action failed. Sensitive details were omitted.');
    expect(wire).not.toContain(error);
  });

  it('keeps a safe multiline error bounded and strips URL credentials, query, and fragment', () => {
    const detail = internalDetail();
    detail.status = 'needs_attention';
    detail.actions[0].status = 'failed';
    detail.runs[0] = {
      ...detail.runs[0],
      status: 'failed',
      error: `Upstream https://user:pass@example.com/v1/jobs?token=secret#private returned 503\n${'safe context '.repeat(300)}`,
    };

    const failure = projectWorkItemDetail(detail).failureReason;

    expect(failure).toContain('Upstream https://example.com/v1/jobs returned 503\n');
    expect(failure.length).toBe(2_000);
    expect(failure).not.toMatch(/user:pass|token=secret|#private/);
  });

  it('projects sanitized failure reasons in live events without leaking raw Run detail', () => {
    const detail = internalDetail();
    detail.status = 'needs_attention';
    detail.actions[0].status = 'failed';
    detail.runs[0].status = 'failed';

    const projected = projectWorkCenterEvent({ type: 'run.finished', workItem: detail });

    expect(projected.workItem.failureReason).toBe('The Action failed. Sensitive details were omitted.');
    expect(projected.workItem.actionStats[0].failureReason).toBe(projected.workItem.failureReason);
    expect(JSON.stringify(projected)).not.toMatch(/user:pass|token=secret|top-secret|\/home\/alice/);
  });

  it('keeps historical failed attempts without showing a stale current failure after success', () => {
    const detail = internalDetail();
    detail.status = 'done';
    detail.actions[0].status = 'completed';
    detail.runs[0].status = 'completed';
    detail.runs[1].error = 'Earlier attempt failed';

    const projected = projectWorkItemDetail(detail);

    expect(projected.failureReason).toBe('');
    expect(projected.actions[0].failureReason).toBe('');
    expect(projected.actions[0].messages.find(message => message.status === 'retryable')).toMatchObject({
      failureReason: 'Earlier attempt failed',
    });
  });

  it('uses the highest progress revision after retry even when the clock moves backward', () => {
    const detail = internalDetail();
    detail.runs = [{
      id: 'r-old', actionId: 'a-1', startedAt: 2_000,
      response: 'Old response', loopCount: 1, toolCount: 1, progressRevision: 8,
    }, {
      id: 'r-new', actionId: 'a-1', startedAt: 1_000,
      response: 'New retry response', loopCount: 2, toolCount: 3, progressRevision: 9,
    }];

    expect(projectWorkItemDetail(detail).actions[0]).toMatchObject({
      response: 'New retry response', progressRevision: 9, loopCount: 3, toolCount: 4,
    });
  });
});
