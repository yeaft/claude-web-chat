import { describe, expect, it } from 'vitest';
import {
  projectActionRequestDetail,
  projectActionRequestIndex,
  projectWorkCenterEvent,
  projectWorkItemDetail,
} from '../../../../agent/yeaft/work-center/projection.js';

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
      waitingReason: 'Choose the compatibility behavior', error: 'private latest error',
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
      id: 'a-1', status: 'completed',
      executionStats: {
        llmRequestCount: 5, loopCount: 3, toolCount: 8,
        inputTokens: 300, outputTokens: 75, cacheReadTokens: 30, cacheWriteTokens: 15,
        totalTokens: 420,
      },
      loopCount: 3, toolCount: 8,
      response: 'Reviewed the change and found one compatibility decision.',
      progressRevision: 4,
      messages: [{
        id: 'run:r-1', role: 'assistant', kind: 'response', status: 'retryable',
        text: 'Earlier retry response', attachments: [], createdAt: 1, updatedAt: 1,
      }, {
        id: 'run:r-2', role: 'assistant', kind: 'response', status: 'waiting',
        text: 'Reviewed the change and found one compatibility decision.', attachments: [], createdAt: 2, updatedAt: 2,
      }],
    }]);
    const wire = JSON.stringify(projected);
    for (const secret of [
      '/project', 'provider/review', 'Review needs a compatibility choice', 'secret latest evidence',
      'private latest error', 'secret-message', 'linus', 'Choose the compatibility behavior',
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
      'private latest error', 'secret persona', 'allowedToolNames', '/private/read',
      'secret-message', 'candidateVpIds', 'private.png', 'secret-digest',
    ]) {
      expect(wire).not.toContain(secret);
    }
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

  it('merges user Action input and assistant Run responses without exposing event data generally', () => {
    const detail = internalDetail();
    detail.events = [{
      id: 9, actionId: 'a-1', type: 'action.guidance_added', createdAt: 0,
      data: {
        guidance: 'Keep the existing public API.',
        attachments: [{
          id: 'att-input', name: 'contract.md', mimeType: 'text/markdown', size: 12,
          isImage: false, storageName: 'private.md', sha256: 'secret',
        }],
      },
    }, {
      id: 10, actionId: 'a-1', type: 'run.claimed', createdAt: 1,
      data: { secret: 'do not project me' },
    }];

    const messages = projectWorkItemDetail(detail).actions[0].messages;
    expect(messages[0]).toEqual({
      id: 'event:9', role: 'user', kind: 'input', status: 'sent',
      text: 'Keep the existing public API.',
      attachments: [{ id: 'att-input', name: 'contract.md', mimeType: 'text/markdown', size: 12, isImage: false }],
      createdAt: 0, updatedAt: 0,
    });
    expect(JSON.stringify(messages)).not.toContain('do not project me');
    expect(JSON.stringify(messages)).not.toContain('private.md');
    expect(JSON.stringify(messages)).not.toContain('secret');
  });

  it('projects request indexes and explicit request details with secrets and binary bodies removed', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const turn = {
      turnId: 'request-1', openedAt: 100, closedAt: 200, loopCount: 1,
      totalMs: 100, totalTokens: 20, summaryInputTokens: 12, summaryOutputTokens: 8,
    };
    expect(projectActionRequestIndex(action, [{ run, turn }])).toEqual({
      actionId: 'a-1',
      requests: [{
        id: 'request-1', runId: 'r-2', status: 'waiting', model: 'provider/review',
        vp: { id: 'martin', name: 'Martin' }, openedAt: 100, closedAt: 200,
        loopCount: 1, totalMs: 100, inputTokens: 12, outputTokens: 8, totalTokens: 20,
      }],
    });

    const projected = projectActionRequestDetail(action, run, {
      turns: [{ ...turn, tools: [{ loopNumber: 1, callId: 'tool-1', name: 'FileRead', toolOutput: 'ok' }] }],
      loops: [{
        loopInstanceId: 'loop-1', loopNumber: 1, model: 'provider/review',
        systemPrompt: 'system', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'secret-image' } }] }],
        response: 'done', usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        latencyMs: 100, stopReason: 'tool_use', toolCalls: [{ id: 'tool-1', name: 'FileRead', input: { file_path: 'src/a.js' } }],
        requestBase: { rawRequest: { headers: { Authorization: 'Bearer secret', Accept: 'application/json' } } },
        rawResponse: { status: 200 },
      }],
    });
    const wire = JSON.stringify(projected);
    expect(projected.request.loops[0]).toMatchObject({
      id: 'loop-1', loopNumber: 1, response: 'done',
      tools: [{ name: 'FileRead', output: 'ok', isError: false }],
      rawRequest: { headers: { Authorization: '***', Accept: 'application/json' } },
    });
    expect(wire).not.toContain('Bearer secret');
    expect(wire).not.toContain('secret-image');
    expect(wire).toContain('binary data omitted');
  });
});
