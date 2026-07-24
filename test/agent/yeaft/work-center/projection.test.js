import { describe, expect, it } from 'vitest';
import {
  projectActionMessagePage,
  projectActionRequestDetail,
  projectActionRequestIndex,
  projectWorkCenterEvent,
  projectWorkItemDetail,
  projectWorkItemSummary,
  MAX_WORK_ITEM_BROWSER_DTO_BYTES,
} from '../../../../agent/yeaft/work-center/projection.js';
import {
  MAX_ACTION_REQUEST_DETAIL_BYTES,
  sanitizeDiagnosticText,
} from '../../../../agent/yeaft/work-center/debug-projection.js';

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
  it('projects mutually exclusive Board lanes with mixed Action counts and real executors', () => {
    const detail = internalDetail();
    detail.status = 'running';
    detail.actions = [{
      id: 'running-action', sequence: 1, type: 'implement', stageId: 'implement', status: 'running',
      brief: { objective: 'Implement the fix' },
    }, {
      id: 'failed-action', sequence: 2, type: 'test', stageId: 'test', status: 'failed',
      brief: { objective: 'Verify the fix' },
    }];
    detail.runs = [{
      id: 'run-active', actionId: 'running-action', workItemId: detail.id, status: 'running', startedAt: 10,
      vpSnapshot: { id: 'linus', name: 'Linus', private: 'omit' },
    }, {
      id: 'run-failed', actionId: 'failed-action', workItemId: detail.id, status: 'failed', startedAt: 11,
      vpSnapshot: { id: 'martin', name: 'Martin', private: 'omit' },
    }];

    expect(projectWorkItemSummary(detail)).toMatchObject({
      boardLane: 'needs_attention',
      actionCounts: { completed: 0, running: 1, ready: 0, waiting: 0, failed: 1 },
      attentionAction: { id: 'failed-action', status: 'failed', assignedVp: { id: 'martin', name: 'Martin' } },
      activeAction: { id: 'running-action', status: 'running', assignedVp: { id: 'linus', name: 'Linus' } },
      executors: [{ id: 'linus', name: 'Linus' }, { id: 'martin', name: 'Martin' }],
    });
    expect(JSON.stringify(projectWorkItemSummary(detail))).not.toContain('private');
    expect(projectWorkItemSummary({ ...detail, status: 'done' }).boardLane).toBe('closed');
    expect(projectWorkItemSummary({ ...detail, status: 'ready', actions: [detail.actions[0]] }).boardLane).toBe('active');
  });

  it('projects identical Board fields for list summaries and live events', () => {
    const detail = internalDetail();
    const summary = projectWorkItemSummary(detail);
    const eventSummary = projectWorkCenterEvent({ type: 'work_item.updated', workItem: detail }).workItem;
    for (const key of ['boardLane', 'actionCounts', 'attentionAction', 'activeAction', 'executors']) {
      expect(eventSummary[key]).toEqual(summary[key]);
    }
  });

  it('projects list Action progress without exposing execution detail', () => {
    const detail = internalDetail();
    detail.actions.push({
      id: 'a-2', workItemId: 'wi-1', sequence: 2, type: 'implement', stageId: 'implement',
      status: 'running', createdAt: 2, updatedAt: 3,
    });
    detail.currentActionId = 'a-2';

    expect(projectWorkItemSummary(detail)).toMatchObject({
      id: 'wi-1',
      actionCount: 2,
      completedActionCount: 1,
      currentAction: { id: 'a-2', type: 'implement', status: 'running' },
    });
  });

  it('broadcasts list state plus safe live Action response and aggregate counts', () => {
    const detail = internalDetail();
    const projected = projectWorkCenterEvent({ type: 'run.finished', workItem: detail });

    expect(projected.workItem).toMatchObject({
      id: 'wi-1', status: 'waiting', workItemType: 'bug-fix', planningMode: 'ai',
    });
    expect(projected.workItem.actionStats).toEqual([{
      id: 'a-1', status: 'completed',
      assignedVp: { id: 'martin', name: 'Martin' },
      contentSummary: 'Reviewed the change and found one compatibility decision.',
      executionStats: {
        llmRequestCount: 5, loopCount: 3, toolCount: 8,
        inputTokens: 300, outputTokens: 75, cacheReadTokens: 30, cacheWriteTokens: 15,
        totalTokens: 420,
      },
      loopCount: 3, toolCount: 8,
      response: 'Reviewed the change and found one compatibility decision.',
      failure: null,
      progressRevision: 4,
      liveMessage: {
        id: 'run:r-2', role: 'assistant', kind: 'response', status: 'waiting',
        text: 'Reviewed the change and found one compatibility decision.', attachments: [],
        createdAt: 2, updatedAt: 2, progressRevision: 4,
      },
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
        assignedVp: { id: 'martin', name: 'Martin' },
        contentSummary: 'Reviewed the change and found one compatibility decision.',
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

  it('projects a bounded Mainline browser view without execution internals', () => {
    const detail = internalDetail();
    Object.assign(detail, {
      executionSchemaVersion: 2,
      lifecycle: 'active',
      attentionState: 'waiting',
      activeActionIds: [],
      attentionActionIds: ['a-1'],
      planRevision: 4,
      ledgerRevision: 9,
    });
    Object.assign(detail.actions[0], {
      generation: 3,
      specHash: 'review-v3',
      dependsOnStageIds: ['implement'],
      status: 'waiting',
      resultRunId: 'r-2',
      contextSnapshot: { secret: 'large internal snapshot' },
    });
    Object.assign(detail.runs[0], {
      actionGeneration: 3,
      actionSpecHash: 'review-v3',
      executionManifest: { schemaVersion: 2, actionGeneration: 3, actionSpecHash: 'review-v3' },
      reviewDecision: 'changes_requested',
      evidence: [{ kind: 'test', label: 'Focused tests', ref: 'projection.test.js', stdout: 'raw output' }],
      debug: { secret: true },
      path: '/private/result',
    });

    const projected = projectWorkItemDetail(detail);
    expect(projected.mainline).toEqual({
      contract: { title: 'Fix', goal: 'Goal', acceptanceCriteria: ['Safe detail'] },
      progress: {
        lifecycle: 'active', attentionState: 'waiting', activeActionIds: [],
        attentionActionIds: ['a-1'], frontierActionIds: [],
        counts: { completed: 0, running: 0, ready: 0, waiting: 1, failed: 0 },
      },
      actions: [{
        id: 'a-1', stageId: 'review', type: 'review', status: 'waiting', generation: 3,
        brief: detail.actions[0].brief, dependencies: ['implement'],
        canonicalResult: {
          status: 'waiting', summary: 'Review needs a compatibility choice',
          evidence: [{ kind: 'test', label: 'Focused tests', ref: 'projection.test.js' }],
          waitingReason: 'Choose the compatibility behavior', reviewDecision: 'changes_requested',
        },
      }],
    });
    expect(projected.actions[0]).toMatchObject(projected.mainline.actions[0]);
    const wire = JSON.stringify(projected.mainline);
    for (const forbidden of ['runs', 'events', 'debug', 'path', 'contextSnapshot', 'raw output', '/private/result', 'runId']) {
      expect(wire).not.toContain(forbidden);
    }
  });

  it('redacts canonical Mainline result diagnostics before browser projection', () => {
    const detail = internalDetail();
    detail.executionSchemaVersion = 2;
    Object.assign(detail.actions[0], { generation: 1, specHash: 'review-v1', resultRunId: 'r-2' });
    Object.assign(detail.runs[0], {
      status: 'completed',
      summary: 'Saved /home/user/private.txt and \\\\server\\private share and \\\\?\\C:\\secret dir and file://server/private/path with token=secret-value',
      evidence: [{ kind: 'file://server/private/kind', label: '\\\\server\\private\\label api_key=secret', ref: 'file://server/private/ref', status: '\\\\?\\C:\\private\\status' }],
      executionManifest: { schemaVersion: 2, actionGeneration: 1, actionSpecHash: 'review-v1' },
    });

    const wire = JSON.stringify(projectWorkItemDetail(detail).mainline);
    for (const secret of ['/home/user/private.txt', 'secret-value', 'api_key=secret', '\\\\server\\private', '\\\\?\\C:\\private', 'file://server/private']) {
      expect(wire).not.toContain(secret);
    }
    expect(wire).toContain('[path redacted]');
  });

  it('does not project generic Action-type fallback text as AI planning', () => {
    const detail = internalDetail();
    detail.actions[0].type = 'triage';
    detail.actions[0].brief = {
      objective: 'Turn the request into a precise, executable Work Item contract and plan.',
      approach: 'Inspect the relevant facts, resolve scope and risks, then select the smallest reliable Action sequence.',
      expectedOutcome: 'A frozen Work Item type, validated contract, and executable Action plan.',
    };

    expect(projectWorkItemDetail(detail).actions[0].brief).toBeNull();
  });

  it('does not project a partially generic brief as AI planning', () => {
    const detail = internalDetail();
    detail.actions[0].type = 'review';
    detail.actions[0].brief = {
      objective: 'Review this exact Work Center picker change',
      approach: 'Prioritize correctness, security, data loss, compatibility, and missing tests over style preferences.',
      expectedOutcome: 'A task-specific decision for the picker change',
    };

    expect(projectWorkItemDetail(detail).actions[0].brief).toBeNull();
  });

  it('projects a bounded, redacted failure diagnostic without exposing other Run internals', () => {
    const detail = internalDetail();
    detail.status = 'needs_attention';
    detail.actions[0].status = 'failed';
    detail.runs[0] = {
      ...detail.runs[0],
      status: 'failed',
      endedAt: 5,
      error: 'Gateway https://user:pass@example.com/v1?api_key=secret failed; Authorization: Bearer token-value',
      summary: 'Unsafe patch was reverted. password=hunter2',
    };

    const projected = projectWorkItemDetail(detail).actions[0];
    expect(projected.failure).toEqual({
      error: 'Gateway https://example.com/v1?api_key=*** failed; Authorization: ***',
      summary: 'Unsafe patch was reverted. password=***',
      failedAt: 5,
    });
    expect(JSON.stringify(projected.failure)).not.toContain('token-value');
    expect(JSON.stringify(projected.failure)).not.toContain('hunter2');
    expect(projected).not.toHaveProperty('evidence');
    const live = projectWorkCenterEvent({ type: 'action.failed', workItem: detail });
    expect(live.workItem.actionStats[0].failure).toEqual(projected.failure);
  });

  it('does not retain an earlier failure after the Action starts a successful retry', () => {
    const detail = internalDetail();
    detail.actions[0].status = 'running';
    detail.runs[0] = { ...detail.runs[0], status: 'running', error: null, summary: '' };
    detail.runs[1] = { ...detail.runs[1], status: 'failed', error: 'Earlier failure', summary: 'Retry me' };

    expect(projectWorkItemDetail(detail).actions[0].failure).toBeNull();
    expect(projectWorkCenterEvent({ type: 'run.progress', workItem: detail }).workItem.actionStats[0].failure).toBeNull();
  });

  it('keeps projected Action stats and failure diagnostics through a second projection', () => {
    const detail = internalDetail();
    detail.status = 'needs_attention';
    detail.actions[0].status = 'failed';
    detail.runs[0] = {
      ...detail.runs[0], status: 'failed', endedAt: 5, error: 'Safe failure', summary: 'Safe summary',
    };

    const once = projectWorkItemDetail(detail);
    const twice = projectWorkItemDetail(once);
    expect(twice.actions[0]).toMatchObject({
      executionStats: once.actions[0].executionStats,
      failure: { error: 'Safe failure', summary: 'Safe summary', failedAt: 5 },
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

  it('isolates Action transcript and execution stats to the current generation', () => {
    const detail = internalDetail();
    detail.actions[0].generation = 2;
    detail.actions[0].specHash = 'review-v2';
    detail.actions[0].identityHistory = [
      { generation: 1, specHash: 'review-v1' },
      { generation: 2, specHash: 'review-v2' },
    ];
    detail.runs = [{
      ...detail.runs[0], id: 'current-run', actionGeneration: 2, actionSpecHash: 'review-v2', actionAttempt: 1,
      response: 'Current generation response', loopCount: 2, toolCount: 3,
    }, {
      ...detail.runs[1], id: 'wrong-spec-run', actionGeneration: 2, actionSpecHash: 'review-other', actionAttempt: 2,
      response: 'Wrong spec response', loopCount: 40, toolCount: 45,
    }, {
      ...detail.runs[1], id: 'old-run', actionGeneration: 1, actionSpecHash: 'review-v1', actionAttempt: 4,
      response: 'Old generation response', loopCount: 50, toolCount: 60,
    }];
    detail.events = [{
      id: 1, actionId: 'a-1', actionGeneration: 1, type: 'action.input_added',
      data: { text: 'Old generation input' }, createdAt: 1,
    }, {
      id: 2, actionId: 'a-1', actionGeneration: 2, type: 'action.input_added',
      data: { text: 'Current generation input' }, createdAt: 2,
    }];

    const projected = projectWorkItemDetail(detail).actions[0];
    expect(projected).toMatchObject({
      generation: 2,
      response: 'Current generation response',
      executionStats: { loopCount: 2, toolCount: 3 },
    });
    expect(projected.messages.map(message => message.text))
      .toEqual(['Current generation input', 'Current generation response']);
    expect(JSON.stringify(projected)).not.toContain('Wrong spec response');
    expect(projectActionMessagePage(detail.actions[0], detail.runs, detail.events).messages
      .map(message => message.text)).toEqual(['Current generation input', 'Current generation response']);
    detail.currentActionId = 'other-action';
    detail.actions.push({
      id: 'other-action', sequence: 2, type: 'test', stageId: 'test', status: 'ready',
      generation: 1, brief: { objective: 'Keep the tested Action historical' },
    });
    expect(projectWorkItemDetail(detail).actions[0]).toMatchObject({
      messageCount: 2,
      messageCursor: '2',
    });

    detail.runs = [];
    expect(projectWorkItemDetail(detail).actions[0]).toMatchObject({
      messageCount: 1,
      messageCursor: '1',
    });
  });

  it('projects the complete Action thread by generation while keeping only the current result canonical', () => {
    const detail = internalDetail();
    detail.actions[0].generation = 2;
    detail.actions[0].specHash = 'review-v2';
    detail.actions[0].identityHistory = [
      { generation: 1, specHash: 'review-v1' },
      { generation: 2, specHash: 'review-v2' },
    ];
    detail.runs = [{
      ...detail.runs[0], id: 'current-run', status: 'running', actionGeneration: 2,
      actionSpecHash: 'review-v2', actionAttempt: 1, response: 'Current response', startedAt: 20,
    }, {
      ...detail.runs[1], id: 'old-run', status: 'failed', actionGeneration: 1,
      actionSpecHash: 'review-v1', actionAttempt: 2, response: 'Old response', startedAt: 10, endedAt: 15,
    }, {
      ...detail.runs[1], id: 'wrong-spec-run', actionGeneration: 2,
      actionSpecHash: 'wrong-spec', actionAttempt: 3, response: 'Wrong spec response', startedAt: 30,
    }];
    detail.events = [{
      id: 1, actionId: 'a-1', actionGeneration: 1, type: 'action.input_added',
      data: { text: 'Old input' }, createdAt: 5,
    }, {
      id: 2, actionId: 'a-1', actionGeneration: 2, type: 'action.input_added',
      data: { text: 'Current input' }, createdAt: 18,
    }, {
      id: 3, actionId: 'a-1', actionGeneration: 1, runId: 'old-run', type: 'run.loop_output',
      data: { response: 'Old loop output', actionAttempt: 2 }, createdAt: 12,
    }];

    const projected = projectWorkItemDetail(detail).actions[0];
    expect(projected.thread).toEqual([
      expect.objectContaining({
        generation: 1, canonical: false,
        messages: [
          expect.objectContaining({ text: 'Old input', generation: 1 }),
          expect.objectContaining({ text: 'Old loop output', generation: 1, runId: 'old-run' }),
        ],
        runs: [expect.objectContaining({ id: 'old-run', attempt: 2, status: 'failed' })],
      }),
      expect.objectContaining({
        generation: 2, canonical: true,
        messages: [],
        runs: [expect.objectContaining({ id: 'current-run', attempt: 1, status: 'running' })],
      }),
    ]);
    expect(JSON.stringify(projected.thread)).not.toContain('Wrong spec response');
    expect(projected.response).toBe('Current response');

    detail.runs[1] = {
      ...detail.runs[1], actionAttempt: 99, startedAt: 999,
    };
    detail.runs.push({
      ...detail.runs[1], id: 'wrong-old-spec', actionSpecHash: 'evil-v1',
      response: 'Newest wrong historical response', actionAttempt: 100, startedAt: 1000,
    });
    const fenced = projectWorkItemDetail(detail).actions[0];
    expect(fenced.thread[0].runs.map(run => run.id)).toEqual(['old-run']);
    expect(JSON.stringify(fenced.thread)).not.toContain('Newest wrong historical response');
    expect(projectActionRequestIndex(detail.actions[0], detail.runs.map(run => ({
      run, turn: { turnId: `request-${run.id}`, startedAt: run.startedAt, endedAt: run.endedAt },
    }))).requests.map(request => request.runId)).toEqual(['old-run', 'current-run']);
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

  it('projects durable Loop responses once when the engine repeats the final response', () => {
    const detail = internalDetail();
    detail.events.push({
      id: 11, workItemId: 'wi-1', actionId: 'a-1', runId: 'r-2',
      type: 'run.loop_output', data: { loopNumber: 1, response: 'Inspected the controller path.' }, createdAt: 3,
    }, {
      id: 12, workItemId: 'wi-1', actionId: 'a-1', runId: 'r-2',
      type: 'run.loop_output', data: { loopNumber: 2, response: 'Implemented the continuation fence.' }, createdAt: 4,
    }, {
      id: 13, workItemId: 'wi-1', actionId: 'a-1', runId: 'r-2',
      type: 'run.loop_output', data: { loopNumber: 3, response: 'Implemented the continuation fence.' }, createdAt: 5,
    });
    detail.runs.find(run => run.id === 'r-2').response = 'Implemented the continuation fence.';

    const action = projectWorkItemDetail(detail).actions[0];
    const messages = action.messages;
    expect(messages.filter(message => message.role === 'assistant')).toEqual([
      expect.objectContaining({ id: 'run:r-1', text: 'Earlier retry response' }),
      expect.objectContaining({ id: 'event:11', text: 'Inspected the controller path.' }),
      expect.objectContaining({ id: 'event:12', text: 'Implemented the continuation fence.' }),
    ]);
    expect(messages).not.toContainEqual(expect.objectContaining({ id: 'event:13' }));
    expect(messages).not.toContainEqual(expect.objectContaining({ id: 'run:r-2' }));
    expect(action.liveMessage).toMatchObject({
      id: 'run:r-2', text: 'Implemented the continuation fence.',
    });
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
      actionId: 'a-1', generation: 1,
      requests: [{
        id: 'request-1', runId: 'r-2', generation: 1, attempt: 1,
        status: 'waiting', model: 'provider/review',
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

    const wrongSpecRun = { ...run, actionGeneration: 1, actionSpecHash: 'wrong-spec' };
    const strictAction = { ...action, generation: 1, specHash: 'current-spec' };
    expect(projectActionRequestIndex(strictAction, [{ run: wrongSpecRun, turn }]).requests).toEqual([]);
    expect(projectActionRequestDetail(strictAction, wrongSpecRun, {
      turns: [{ ...turn, tools: [] }], loops: [],
    })).toBeNull();

    const currentAction = {
      ...strictAction,
      generation: 2,
      specHash: 'current-v2',
      identityHistory: [
        { generation: 1, specHash: 'current-spec' },
        { generation: 2, specHash: 'current-v2' },
      ],
    };
    const historicalRun = { ...run, actionGeneration: 1, actionSpecHash: 'current-spec' };
    expect(projectActionRequestIndex(currentAction, [{ run: historicalRun, turn }]).requests)
      .toEqual([expect.objectContaining({ runId: historicalRun.id, generation: 1 })]);
    expect(projectActionRequestDetail(currentAction, historicalRun, {
      turns: [{ ...turn, tools: [] }], loops: [],
    })).toMatchObject({ request: { runId: historicalRun.id } });

    const wrongHistoricalSpec = { ...historicalRun, id: 'wrong-history', actionSpecHash: 'wrong-v1' };
    expect(projectActionRequestIndex(currentAction, [
      { run: historicalRun, turn },
      { run: wrongHistoricalSpec, turn: { ...turn, turnId: 'wrong-request' } },
    ]).requests).toEqual([expect.objectContaining({ runId: historicalRun.id })]);
    expect(projectActionRequestDetail(currentAction, wrongHistoricalSpec, {
      turns: [{ ...turn, tools: [] }], loops: [],
    }, [historicalRun, wrongHistoricalSpec])).toBeNull();
  });

  it('redacts complete sensitive header values across browser DTO header shapes', () => {
    const detail = internalDetail();
    const projected = projectActionRequestDetail(detail.actions[0], detail.runs[0], {
      turns: [{ turnId: 'request-header-shapes', tools: [] }],
      loops: [
        { loopNumber: 1, messages: [], toolCalls: [], requestBase: { rawRequest: { headers: {
          Authorization: 'Basic LEAK_BASIC',
          'Proxy-Authorization': 'Digest LEAK_DIGEST',
          Cookie: 'session=LEAK_COOKIE',
          Accept: 'application/json',
        } } } },
        { loopNumber: 2, messages: [], toolCalls: [], requestBase: { rawRequest: { headers: [
          ['Authorization', 'Negotiate LEAK_NEGOTIATE'],
          ['x-api-key', 'LEAK_TUPLE_API'],
          ['Accept', 'text/plain'],
        ] } } },
        { loopNumber: 3, messages: [], toolCalls: [], requestBase: { rawRequest: { rawHeaders: [
          'Authorization', 'Custom LEAK_CUSTOM', 'Set-Cookie', 'sid=LEAK_SET_COOKIE',
          'Accept', 'text/event-stream',
        ] } } },
        { loopNumber: 4, messages: [], toolCalls: [], rawResponse: {
          body: 'Authorization: Basic LEAK_TEXT\r\nX-Safe: visible',
        } },
        { loopNumber: 5, messages: [], toolCalls: [], requestBase: { rawRequest: {
          headers: 'Cookie: a=LEAK_COOKIE_A; b=LEAK_COOKIE_B\r\nX-Safe: visible',
        } } },
        { loopNumber: 6, messages: [], toolCalls: [], rawResponse: {
          body: 'Set-Cookie: a=LEAK_SET_COOKIE_A; Path=/; note=LEAK_SET_COOKIE_B\r\nX-Safe: visible',
        } },
        { loopNumber: 7, messages: [], toolCalls: [], requestBase: { rawRequest: {
          headers: 'prefix=visible\rCookie: a=LEAK_CR_COOKIE_A; b=LEAK_CR_COOKIE_B\rX-Safe: visible',
        } } },
        { loopNumber: 8, messages: [], toolCalls: [], rawResponse: {
          body: 'prefix=visible\rSet-Cookie: a=LEAK_CR_SET_COOKIE_A; Path=/; note=LEAK_CR_SET_COOKIE_B\rX-Safe: visible',
        } },
      ],
    });

    const wire = JSON.stringify(projected);
    for (const secret of [
      'LEAK_BASIC', 'LEAK_DIGEST', 'LEAK_COOKIE', 'LEAK_NEGOTIATE',
      'LEAK_TUPLE_API', 'LEAK_CUSTOM', 'LEAK_SET_COOKIE', 'LEAK_TEXT',
      'LEAK_COOKIE_A', 'LEAK_COOKIE_B', 'LEAK_SET_COOKIE_A', 'LEAK_SET_COOKIE_B',
      'LEAK_CR_COOKIE_A', 'LEAK_CR_COOKIE_B', 'LEAK_CR_SET_COOKIE_A', 'LEAK_CR_SET_COOKIE_B',
    ]) expect(wire).not.toContain(secret);
    expect(projected.request.loops[0].rawRequest.headers.Accept).toBe('application/json');
    expect(projected.request.loops[1].rawRequest.headers[2]).toEqual(['Accept', 'text/plain']);
    expect(projected.request.loops[2].rawRequest.rawHeaders.at(-1)).toBe('text/event-stream');
    expect(projected.request.loops[3].rawResponse.body).toContain('X-Safe: visible');
    expect(projected.request.loops[4].rawRequest.headers).toBe('Cookie: ***\r\nX-Safe: visible');
    expect(projected.request.loops[5].rawResponse.body).toBe('Set-Cookie: ***\r\nX-Safe: visible');
    expect(projected.request.loops[6].rawRequest.headers).toBe('prefix=visible\rCookie: ***\rX-Safe: visible');
    expect(projected.request.loops[7].rawResponse.body).toBe('prefix=visible\rSet-Cookie: ***\rX-Safe: visible');
  });

  it('redacts URL credentials, secret query values, and binary data embedded in SSE', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const secretBlob = 'a'.repeat(4_096);
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-secret', tools: [] }],
      loops: [{
        loopNumber: 1, model: 'provider/review', messages: [], toolCalls: [],
        requestBase: { rawRequest: {
          url: 'https://alice:password@example.test/v1?api_key=query-secret&safe=yes',
          headers: { Authorization: 'Bearer secret' },
        } },
        rawResponse: {
          format: 'sse',
          body: `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'base64', data: secretBlob } })}\n\n`,
        },
      }],
    });

    const wire = JSON.stringify(projected);
    expect(wire).not.toContain('alice');
    expect(wire).not.toContain('password');
    expect(wire).not.toContain('query-secret');
    expect(wire).not.toContain(secretBlob);
    expect(projected.request.loops[0].rawRequest.url).toContain('api_key=***');
    expect(projected.request.loops[0].rawRequest.url).toContain('safe=yes');
    expect(wire).toContain('binary data omitted');
  });

  it('recursively redacts secret fields, JSON error bodies, and non-JSON SSE text', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-redaction', tools: [] }],
      loops: [{
        loopNumber: 1, messages: [], toolCalls: [],
        requestBase: { rawRequest: {
          body: {
            apiKey: 'object-api-key',
            nested: {
              access_token: 'object-access-token',
              clientSecret: 'object-client-secret',
              'x-api-key': 'LEAK_X',
              'proxy-authorization': 'LEAK_P',
            },
          },
        } },
        rawResponse: {
          status: 401,
          body: '{"secret":"LEAK_MALFORMED"',
          stream: {
            format: 'sse',
            body: 'data: secret=LEAK_SSE',
          },
        },
      }],
    });

    const wire = JSON.stringify(projected);
    for (const secret of [
      'object-api-key', 'object-access-token', 'object-client-secret',
      'LEAK_X', 'LEAK_P', 'LEAK_MALFORMED', 'LEAK_SSE',
    ]) expect(wire).not.toContain(secret);
    expect(projected.request.loops[0].rawRequest.body.nested).toEqual({
      access_token: '***', clientSecret: '***', 'x-api-key': '***', 'proxy-authorization': '***',
    });
    expect(projected.request.loops[0].rawResponse.body)
      .toBe('[redacted malformed JSON: sensitive data]');
    expect(projected.request.loops[0].rawResponse.stream.body)
      .toContain('[redacted SSE event: malformed sensitive data]');
  });

  it('redacts sensitive malformed JSON and multi-line SSE events from the final browser DTO', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-malformed-redaction', tools: [] }],
      loops: [
        {
          loopNumber: 1, messages: [], toolCalls: [],
          rawResponse: { body: '{"secret":"LEAK_JSON_TRUNCATED' },
        },
        {
          loopNumber: 2, messages: [], toolCalls: [],
          rawResponse: { body: '{"secret":"LEAK_JSON_NEWLINE\ncontinued"}' },
        },
        {
          loopNumber: 3, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'data: {"secret":"\ndata: LEAK_SSE_MULTILINE"}\n\n',
          },
        },
        {
          loopNumber: 4, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'data: {"token":"LEAK_SSE_TRUNCATED\ndata: continued\n\n',
          },
        },
      ],
    });

    const wire = JSON.stringify(projected);
    for (const secret of [
      'LEAK_JSON_TRUNCATED', 'LEAK_JSON_NEWLINE',
      'LEAK_SSE_MULTILINE', 'LEAK_SSE_TRUNCATED',
    ]) expect(wire).not.toContain(secret);
    expect(wire).toContain('redacted malformed JSON');
    expect(wire).toContain('redacted SSE event');
  });

  it('redacts sensitive SSE metadata and comments even when an event has data', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-sse-metadata-redaction', tools: [] }],
      loops: [
        {
          loopNumber: 1, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'event: secret=LEAK_EVENT\ndata: [DONE]\n\n',
          },
        },
        {
          loopNumber: 2, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'id: token=LEAK_ID\ndata: safe\n\n',
          },
        },
        {
          loopNumber: 3, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: ': authorization=Bearer LEAK_COMMENT\ndata: {"message":"safe"}\n\n',
          },
        },
        {
          loopNumber: 4, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'retry: credential=LEAK_RETRY\ndata: safe\n\n',
          },
        },
      ],
    });

    const wire = JSON.stringify(projected);
    for (const secret of ['LEAK_EVENT', 'LEAK_ID', 'LEAK_COMMENT', 'LEAK_RETRY']) {
      expect(wire).not.toContain(secret);
    }
    expect(wire).toContain('event: secret=***');
    expect(wire).toContain('id: token=***');
    expect(wire).toContain(': authorization=***');
    expect(wire).toContain('retry: credential=***');
    expect(wire).toContain('[DONE]');
  });

  it('uses normalized sensitive-name semantics for malformed quoted JSON keys', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const malformedBodies = [
      '{"api.key":"LEAK_API_DOT',
      '{"x.api.key":"LEAK_X_API_DOT',
      '{"api key":"LEAK_API_SPACE',
      '{"x api key":"LEAK_X_API_SPACE',
      '{"api$key":"LEAK_API_DOLLAR',
    ];
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-normalized-key-redaction', tools: [] }],
      loops: [
        ...malformedBodies.map((body, index) => ({
          loopNumber: index + 1, messages: [], toolCalls: [], rawResponse: { body },
        })),
        {
          loopNumber: malformedBodies.length + 1, messages: [], toolCalls: [],
          rawResponse: { body: '{"api.key":"LEAK_VALID"}' },
        },
      ],
    });

    const wire = JSON.stringify(projected);
    for (const secret of [
      'LEAK_API_DOT', 'LEAK_X_API_DOT', 'LEAK_API_SPACE',
      'LEAK_X_API_SPACE', 'LEAK_API_DOLLAR', 'LEAK_VALID',
    ]) expect(wire).not.toContain(secret);
    for (const loop of projected.request.loops.slice(0, malformedBodies.length)) {
      expect(loop.rawResponse.body).toBe('[redacted malformed JSON: sensitive data]');
    }
    expect(projected.request.loops.at(-1).rawResponse.body).toBe('{"api.key":"***"}');
  });

  it('redacts normalized SSE metadata names and unicode-escaped malformed JSON keys', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-normalized-boundary-redaction', tools: [] }],
      loops: [
        {
          loopNumber: 1, messages: [], toolCalls: [],
          rawResponse: { format: 'sse', body: 'event: api.key=LEAK_META_DOT\ndata: safe\n\n' },
        },
        {
          loopNumber: 2, messages: [], toolCalls: [],
          rawResponse: { format: 'sse', body: 'id: x api key=LEAK_META_SPACE\ndata: [DONE]\n\n' },
        },
        {
          loopNumber: 3, messages: [], toolCalls: [],
          rawResponse: { format: 'sse', body: ': api$key=LEAK_META_DOLLAR\ndata: safe\n\n' },
        },
        {
          loopNumber: 4, messages: [], toolCalls: [],
          rawResponse: { body: '{"api\\u002ekey":"LEAK_UNICODE' },
        },
        {
          loopNumber: 5, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'data: {"api\\u002ekey":"LEAK_SSE_UNICODE\n\n',
          },
        },
        {
          loopNumber: 6, messages: [], toolCalls: [],
          rawResponse: { body: '{"api\\u002ekey":"LEAK_VALID_UNICODE"}' },
        },
      ],
    });

    const wire = JSON.stringify(projected);
    for (const secret of [
      'LEAK_META_DOT', 'LEAK_META_SPACE', 'LEAK_META_DOLLAR',
      'LEAK_UNICODE', 'LEAK_SSE_UNICODE', 'LEAK_VALID_UNICODE',
    ]) expect(wire).not.toContain(secret);
    expect(projected.request.loops[0].rawResponse.body).toContain('event: api.key=***');
    expect(projected.request.loops[1].rawResponse.body).toContain('id: x api key=***');
    expect(projected.request.loops[2].rawResponse.body).toContain(': api$key=***');
    expect(projected.request.loops[3].rawResponse.body)
      .toBe('[redacted malformed JSON: sensitive data]');
    expect(projected.request.loops[4].rawResponse.body)
      .toContain('[redacted SSE event: malformed sensitive data]');
    expect(projected.request.loops[5].rawResponse.body).toBe('{"api.key":"***"}');
    const failureWire = JSON.stringify(projectWorkItemDetail({
      ...detail,
      actions: [{
        ...action,
        failure: {
          error: '(password=LEAK_PAREN) and prefix x-api.key=LEAK_PREFIX',
          summary: 'safe assignment: monkey=value',
          failedAt: 10,
        },
      }],
    }));
    expect(failureWire).not.toContain('LEAK_PAREN');
    expect(failureWire).not.toContain('LEAK_PREFIX');
    expect(sanitizeDiagnosticText('safe assignment: monkey=value')).toContain('monkey=value');
  });

  it('uses normalized sensitive-name semantics for SSE metadata and bare diagnostics', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const sensitiveCases = [
      { prefix: 'event: ', name: '_api.key', secret: 'SECRET__api.key' },
      { prefix: 'event: ', name: 'api.key_', secret: 'SECRET_api.key_' },
      { prefix: 'event: ', name: '_token', secret: 'SECRET__token' },
      { prefix: 'event: ', name: 'token_', secret: 'SECRET_token_' },
    ];
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-normalized-diagnostic-redaction', tools: [] }],
      loops: [
        ...sensitiveCases.map(({ prefix, name, secret }, index) => ({
          loopNumber: index + 1,
          messages: [],
          toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: `${prefix}${name}=${secret}\ndata: safe\n\n`,
          },
        })),
        ...sensitiveCases.map(({ name, secret }, index) => ({
          loopNumber: sensitiveCases.length + index + 1,
          messages: [],
          toolCalls: [],
          rawResponse: { body: `${name}=${secret}` },
        })),
        ...sensitiveCases.map(({ name }, index) => ({
          loopNumber: sensitiveCases.length * 2 + index + 1,
          messages: [],
          toolCalls: [],
          rawResponse: { body: JSON.stringify({ [name]: 'SECRET' }) },
        })),
        {
          loopNumber: sensitiveCases.length * 3 + 1,
          messages: [],
          toolCalls: [],
          rawResponse: { body: 'status_code=429; upstream reason: capacity exhausted' },
        },
      ],
    });

    const wire = JSON.stringify(projected);
    for (const { secret } of sensitiveCases) expect(wire).not.toContain(secret);
    for (const [index, loop] of projected.request.loops.slice(0, sensitiveCases.length).entries()) {
      expect(loop.rawResponse.body)
        .toContain(`${sensitiveCases[index].prefix}${sensitiveCases[index].name}=***`);
      expect(loop.rawResponse.body).toContain('data: safe');
    }
    for (const loop of projected.request.loops.slice(sensitiveCases.length, sensitiveCases.length * 2)) {
      expect(loop.rawResponse.body).toContain('=***');
    }
    for (const [index, loop] of projected.request.loops
      .slice(sensitiveCases.length * 2, sensitiveCases.length * 3).entries()) {
      expect(loop.rawResponse.body).toBe(JSON.stringify({ [sensitiveCases[index].name]: '***' }));
    }
    expect(projected.request.loops.at(-1).rawResponse.body)
      .toBe('status_code=429; upstream reason: capacity exhausted');
  });

  it('redacts no-space SSE fields and prefixed bare diagnostics in the final browser DTO', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-no-space-sse-redaction', tools: [] }],
      loops: [
        {
          loopNumber: 1, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'event:_api.key=LEAK_EVENT_NOSPACE\ndata: safe\n\n',
          },
        },
        {
          loopNumber: 2, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'id:_api.key=LEAK_ID_NOSPACE\ndata: first\ndata: second',
          },
        },
        {
          loopNumber: 3, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'retry:_token=LEAK_RETRY_NOSPACE\ndata: safe\n\n',
          },
        },
        {
          loopNumber: 4, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: ':_api.key=LEAK_COMMENT_NOSPACE\ndata: safe\n\n',
          },
        },
        {
          loopNumber: 5, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'event:_token=LEAK_CRLF\r\ndata: [DONE]\r\n\r\n',
          },
        },
        {
          loopNumber: 6, messages: [], toolCalls: [],
          rawResponse: { body: 'provider:_api.key=LEAK_PROVIDER; status_code=429' },
        },
        {
          loopNumber: 7, messages: [], toolCalls: [],
          rawResponse: { body: 'https://example.test/v1?api_key=LEAK_URL&safe=yes' },
        },
      ],
    });

    const wire = JSON.stringify(projected);
    for (const secret of [
      'LEAK_EVENT_NOSPACE', 'LEAK_ID_NOSPACE', 'LEAK_RETRY_NOSPACE',
      'LEAK_COMMENT_NOSPACE', 'LEAK_CRLF', 'LEAK_PROVIDER', 'LEAK_URL',
    ]) expect(wire).not.toContain(secret);
    expect(projected.request.loops[0].rawResponse.body).toContain('event:_api.key=***');
    expect(projected.request.loops[1].rawResponse.body).toContain('id:_api.key=***');
    expect(projected.request.loops[1].rawResponse.body).toContain('data: first\ndata: second');
    expect(projected.request.loops[2].rawResponse.body).toContain('retry:_token=***');
    expect(projected.request.loops[3].rawResponse.body).toContain(':_api.key=***');
    expect(projected.request.loops[4].rawResponse.body).toContain('event:_token=***');
    expect(projected.request.loops[4].rawResponse.body).toContain('data: [DONE]');
    expect(projected.request.loops[5].rawResponse.body)
      .toBe('provider:_api.key=***; status_code=429');
    expect(projected.request.loops[6].rawResponse.body).toContain('api_key=***');
    expect(projected.request.loops[6].rawResponse.body).toContain('safe=yes');
    expect(sanitizeDiagnosticText('safe assignment: monkey=value')).toContain('monkey=value');
  });

  it('preserves colon-delimited normalized sensitive names across bare and SSE diagnostics', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-colon-name-redaction', tools: [] }],
      loops: [
        {
          loopNumber: 1, messages: [], toolCalls: [],
          rawResponse: { body: 'api:key=LEAK_API_KEY' },
        },
        {
          loopNumber: 2, messages: [], toolCalls: [],
          rawResponse: { body: 'x:api:key=LEAK_X_API_KEY' },
        },
        {
          loopNumber: 3, messages: [], toolCalls: [],
          rawResponse: { body: 'provider:api:key=LEAK_PREFIXED_API_KEY' },
        },
        {
          loopNumber: 4, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'event:api:key=LEAK_SSE_API_KEY\ndata: safe\n\n',
          },
        },
        {
          loopNumber: 5, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'event:x:api:key=LEAK_SSE_X_API_KEY\ndata: [DONE]\n\n',
          },
        },
        {
          loopNumber: 6, messages: [], toolCalls: [],
          rawResponse: { body: JSON.stringify({ 'api:key': 'LEAK_OBJECT_API_KEY' }) },
        },
        {
          loopNumber: 7, messages: [], toolCalls: [],
          rawResponse: { body: JSON.stringify({ 'x:api:key': 'LEAK_OBJECT_X_API_KEY' }) },
        },
      ],
    });

    const wire = JSON.stringify(projected);
    for (const secret of [
      'LEAK_API_KEY', 'LEAK_X_API_KEY', 'LEAK_PREFIXED_API_KEY',
      'LEAK_SSE_API_KEY', 'LEAK_SSE_X_API_KEY',
      'LEAK_OBJECT_API_KEY', 'LEAK_OBJECT_X_API_KEY',
    ]) expect(wire).not.toContain(secret);
    expect(projected.request.loops[0].rawResponse.body).toBe('api:key=***');
    expect(projected.request.loops[1].rawResponse.body).toBe('x:api:key=***');
    expect(projected.request.loops[2].rawResponse.body).toBe('provider:api:key=***');
    expect(projected.request.loops[3].rawResponse.body).toContain('event:api:key=***');
    expect(projected.request.loops[3].rawResponse.body).toContain('data: safe');
    expect(projected.request.loops[4].rawResponse.body).toContain('event:x:api:key=***');
    expect(projected.request.loops[4].rawResponse.body).toContain('data: [DONE]');
    expect(projected.request.loops[5].rawResponse.body).toBe('{"api:key":"***"}');
    expect(projected.request.loops[6].rawResponse.body).toBe('{"x:api:key":"***"}');
  });

  it('bounds sanitizer work while preserving URL, SSE, and diagnostic structure', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const colonDense = `${'safe:'.repeat(1_200)}status=ok`;
    const startedAt = performance.now();
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-bounded-diagnostics', tools: [] }],
      loops: [
        {
          loopNumber: 1, messages: [], toolCalls: [],
          rawResponse: { body: 'GET https://[invalid]/?%61pi%5Fkey=LEAK_ENCODED_API&safe=yes' },
        },
        {
          loopNumber: 2, messages: [], toolCalls: [],
          rawResponse: { body: 'GET https://[invalid]/?%74oken=LEAK_ENCODED_TOKEN&safe=yes' },
        },
        {
          loopNumber: 3, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'event:auth:required\nid:code:12345\ndata: safe\n\n',
          },
        },
        {
          loopNumber: 4, messages: [], toolCalls: [],
          rawResponse: { body: 'endpoint http://auth:8080/health?safe=yes' },
        },
        {
          loopNumber: 5, messages: [], toolCalls: [],
          rawResponse: { body: 'provider note: status code: invalid' },
        },
        {
          loopNumber: 6, messages: [], toolCalls: [],
          rawResponse: { body: colonDense },
        },
        {
          loopNumber: 7, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'event:auth:required\nid:code:12345\n: token: LEAK_SSE_TOKEN\ndata: safe\n\n',
          },
        },
        {
          loopNumber: 8, messages: [], toolCalls: [],
          rawResponse: {
            body: 'GET https://[invalid]/?%2561pi%255Fkey=LEAK_DOUBLE_ENCODED&safe=yes',
          },
        },
        {
          loopNumber: 9, messages: [], toolCalls: [],
          rawResponse: {
            body: 'GET https://example.test/?%2561pi%255Fkey=LEAK_VALID_DOUBLE&safe=yes',
          },
        },
        {
          loopNumber: 10, messages: [], toolCalls: [],
          rawResponse: {
            body: 'GET https://example.test/?%252525zz=LEAK_RESIDUAL_PERCENT&safe=yes',
          },
        },
        {
          loopNumber: 11, messages: [], toolCalls: [],
          rawResponse: {
            body: 'GET https://example.test/?password%252525zz=LEAK_MIXED_PERCENT&safe=yes',
          },
        },
      ],
    });
    const elapsedMs = performance.now() - startedAt;
    const wire = JSON.stringify(projected);

    expect(wire).not.toContain('LEAK_ENCODED_API');
    expect(wire).not.toContain('LEAK_ENCODED_TOKEN');
    expect(projected.request.loops[0].rawResponse.body).toContain('%61pi%5Fkey=***&safe=yes');
    expect(projected.request.loops[1].rawResponse.body).toContain('%74oken=***&safe=yes');
    expect(projected.request.loops[2].rawResponse.body)
      .toContain('event:auth:required\nid:code:12345\ndata: safe');
    expect(projected.request.loops[3].rawResponse.body)
      .toBe('endpoint http://auth:8080/health?safe=yes');
    expect(projected.request.loops[4].rawResponse.body)
      .toBe('provider note: status code: invalid');
    expect(projected.request.loops[5].rawResponse.body).toBe(colonDense);
    expect(projected.request.loops[6].rawResponse.body).toContain(': token: ***');
    expect(projected.request.loops[6].rawResponse.body).not.toContain('LEAK_SSE_TOKEN');
    expect(projected.request.loops[7].rawResponse.body)
      .toContain('%2561pi%255Fkey=***&safe=yes');
    expect(projected.request.loops[8].rawResponse.body)
      .toContain('%2561pi%255Fkey=***&safe=yes');
    expect(projected.request.loops[9].rawResponse.body)
      .toContain('%252525zz=***&safe=yes');
    expect(projected.request.loops[10].rawResponse.body)
      .toContain('password%252525zz=***&safe=yes');
    for (const secret of [
      'LEAK_DOUBLE_ENCODED', 'LEAK_VALID_DOUBLE',
      'LEAK_RESIDUAL_PERCENT', 'LEAK_MIXED_PERCENT',
    ]) expect(wire).not.toContain(secret);
    expect(sanitizeDiagnosticText('foo=bar&token=LEAK_SECOND&safe=yes'))
      .toBe('foo=bar&token=***&safe=yes');
    expect(sanitizeDiagnosticText('foo=bar; api.key=LEAK_THIRD, safe=yes'))
      .toBe('foo=bar; api.key=***, safe=yes');
    expect(sanitizeDiagnosticText('token=LEAK_FIRST=token=LEAK_SECOND'))
      .toBe('token=***=token=***');
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('sanitizes direct and current-Run waiting reasons at the browser boundary', () => {
    const detail = internalDetail();
    detail.waitingReason = [
      'Need input token=LEAK_DIRECT_TOKEN',
      'Authorization: Bearer LEAK_DIRECT_BEARER',
      'password: LEAK_DIRECT_PASSWORD',
      'token=LEAK_FIRST password: LEAK_DIRECT_SECOND',
      'Need input token:LEAK_DIRECT_NOSPACE',
      'provider note: status code: invalid',
    ].join('; ');
    let projected = projectWorkItemDetail(detail);
    expect(projected.waitingReason).toContain('Need input token=***');
    expect(projected.waitingReason).toContain('password: ***');
    expect(projected.waitingReason).toContain('Need input token:***');
    expect(projected.waitingReason).toContain('provider note: status code: invalid');
    for (const secret of [
      'LEAK_DIRECT_TOKEN', 'LEAK_DIRECT_BEARER', 'LEAK_DIRECT_PASSWORD',
      'LEAK_FIRST', 'LEAK_DIRECT_SECOND', 'LEAK_DIRECT_NOSPACE',
    ]) expect(projected.waitingReason).not.toContain(secret);

    for (const [reason, secrets] of [
      ['password="LEAK_DIRECT_QUOTED token=LEAK_DIRECT_INNER', ['LEAK_DIRECT_QUOTED', 'LEAK_DIRECT_INNER']],
      [`password:${' '.repeat(255)}LEAK_DIRECT_255`, ['LEAK_DIRECT_255']],
      [`password:${' '.repeat(256)}LEAK_DIRECT_256`, ['LEAK_DIRECT_256']],
    ]) {
      detail.waitingReason = reason;
      projected = projectWorkItemDetail(detail);
      for (const secret of secrets) expect(projected.waitingReason).not.toContain(secret);
    }

    delete detail.waitingReason;
    for (const [reason, secrets] of [
      [
        'Provider asks for client secret: LEAK_RUN_SECRET; Need input token=LEAK_RUN_TOKEN; Authorization: Bearer LEAK_RUN_BEARER',
        ['LEAK_RUN_SECRET', 'LEAK_RUN_TOKEN', 'LEAK_RUN_BEARER'],
      ],
      ['password="LEAK_RUN_QUOTED token=LEAK_RUN_INNER', ['LEAK_RUN_QUOTED', 'LEAK_RUN_INNER']],
      [`password:${' '.repeat(256)}LEAK_RUN_256`, ['LEAK_RUN_256']],
    ]) {
      detail.runs[0].waitingReason = reason;
      projected = projectWorkItemDetail(detail);
      for (const secret of secrets) expect(projected.waitingReason).not.toContain(secret);
    }
  });

  it('keeps non-sensitive malformed JSON and multi-line SSE diagnostics visible', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-safe-malformed', tools: [] }],
      loops: [
        {
          loopNumber: 1, messages: [], toolCalls: [],
          rawResponse: { body: '{"message":"upstream unavailable' },
        },
        {
          loopNumber: 2, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'event: update\ndata: first line\ndata: second line\n\ndata: [DONE]\n\n',
          },
        },
        {
          loopNumber: 3, messages: [], toolCalls: [],
          rawResponse: {
            format: 'sse',
            body: 'data: {"message":\ndata: "safe"}\n\n',
          },
        },
      ],
    });

    const wire = JSON.stringify(projected);
    expect(wire).toContain('upstream unavailable');
    expect(wire).toContain('first line');
    expect(wire).toContain('second line');
    expect(wire).toContain('[DONE]');
    expect(wire).toContain('safe');
  });

  it('bounds raw Action request inputs before sanitization', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const dense = 'token=x;'.repeat(8_192);
    const startedAt = performance.now();
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-input-budget', tools: [] }],
      loops: Array.from({ length: 128 }, (_, index) => ({
        loopInstanceId: `budget-loop-${index}`,
        loopNumber: index + 1,
        messages: [],
        toolCalls: [],
        rawResponse: { body: dense },
      })),
    });
    const elapsedMs = performance.now() - startedAt;

    expect(projected.request.loopCount).toBe(128);
    expect(projected.request.truncated).toBe(true);
    expect(projected.request.omittedLoopCount).toBeGreaterThanOrEqual(124);
    expect(projected.request.loops.length).toBeLessThanOrEqual(4);
    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8'))
      .toBeLessThanOrEqual(MAX_ACTION_REQUEST_DETAIL_BYTES);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('enforces one UTF-8 byte budget for the complete Action request detail DTO', () => {
    const detail = internalDetail();
    const action = detail.actions[0];
    const run = detail.runs[0];
    const hugeUnicode = '界'.repeat(MAX_ACTION_REQUEST_DETAIL_BYTES);
    const projected = projectActionRequestDetail(action, run, {
      turns: [{ turnId: 'request-large', tools: [] }],
      loops: Array.from({ length: 6 }, (_, index) => ({
        loopInstanceId: `loop-${index}`, loopNumber: index + 1,
        model: 'provider/review', systemPrompt: hugeUnicode, messages: [],
        response: hugeUnicode, toolCalls: [], rawResponse: { body: hugeUnicode },
      })),
    });

    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8'))
      .toBeLessThanOrEqual(MAX_ACTION_REQUEST_DETAIL_BYTES);
    expect(projected.request.truncated).toBe(true);

    action.id = hugeUnicode;
    run.actionId = hugeUnicode;
    run.id = hugeUnicode;
    run.status = hugeUnicode;
    run.modelSnapshot.id = hugeUnicode;
    run.vpSnapshot.id = hugeUnicode;
    run.vpSnapshot.name = hugeUnicode;
    const metadataHeavy = projectActionRequestDetail(action, run, {
      turns: [{ turnId: hugeUnicode, tools: [] }],
      loops: [],
    });
    expect(Buffer.byteLength(JSON.stringify(metadataHeavy), 'utf8'))
      .toBeLessThanOrEqual(MAX_ACTION_REQUEST_DETAIL_BYTES);
    expect(metadataHeavy.request.truncated).toBe(true);
  });

  it('bounds full Action history while keeping live event payloads message-free', () => {
    const detail = internalDetail();
    detail.runs = Array.from({ length: 100 }, (_, index) => ({
      id: `run-${index}`, actionId: 'a-1', startedAt: index,
      response: `response-${index}-${'x'.repeat(16_000)}`,
      progressRevision: index + 1,
    }));

    const full = projectWorkItemDetail(detail);
    const live = projectWorkCenterEvent({ type: 'run.progress', workItem: detail });
    expect(full.actions[0]).toMatchObject({ messageCount: 100, messageCursor: '80' });
    expect(full.actions[0].messages).toHaveLength(20);
    expect(projectActionMessagePage(detail.actions[0], detail.runs, detail.events, {
      cursor: full.actions[0].messageCursor,
      limit: 20,
    })).toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ id: 'run:run-60' })]),
      nextCursor: '60',
      total: 100,
    });
    expect(live.workItem.actionStats[0]).not.toHaveProperty('messages');
    expect(live.workItem.actionStats[0].liveMessage).toMatchObject({
      id: 'run:run-99',
      text: expect.stringContaining('response-99'),
      progressRevision: 100,
    });
    expect(Buffer.byteLength(JSON.stringify(live), 'utf8')).toBeLessThan(40_000);
  });

  it('enforces one UTF-8 budget for large WorkItem detail and live event DTOs', () => {
    const response = '界'.repeat(16_000);
    const actions = Array.from({ length: 100 }, (_, index) => ({
      id: `action-${index}`,
      sequence: index + 1,
      type: 'implement',
      status: index === 99 ? 'running' : 'completed',
      brief: {
        objective: response,
        approach: response,
        expectedOutcome: response,
      },
    }));
    const runs = actions.map((action, index) => ({
      id: `run-${index}`,
      actionId: action.id,
      status: action.status,
      response,
      startedAt: index + 1,
      progressRevision: index + 1,
    }));
    const detail = {
      id: 'wi-large', revision: 1, title: 'Large', goal: 'Bound it', status: 'running',
      currentActionId: 'action-99', actions, runs, events: [],
    };
    const projected = projectWorkItemDetail(detail);
    const live = projectWorkCenterEvent({ type: 'run.progress', workItem: detail });

    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8'))
      .toBeLessThanOrEqual(MAX_WORK_ITEM_BROWSER_DTO_BYTES);
    expect(Buffer.byteLength(JSON.stringify(live), 'utf8'))
      .toBeLessThanOrEqual(MAX_WORK_ITEM_BROWSER_DTO_BYTES);
    expect(projected.actions).toHaveLength(100);
    expect(projected.actions[0]).not.toHaveProperty('messages');
    expect(projected.actions[0]).not.toHaveProperty('response');
    expect(projected.actions[0]).toMatchObject({ messageCount: 1, messageCursor: '1' });
    expect(projected.actions[99].liveMessage.text).toHaveLength(16_000);
    expect(live.workItem.actionStats).toHaveLength(100);
    expect(live.workItem.actionStats[0]).not.toHaveProperty('liveMessage');
    expect(live.workItem.actionStats[99].liveMessage.text).toHaveLength(16_000);

    detail.events.push({
      id: 'historical-input', actionId: 'action-0', type: 'action.input_added',
      data: { text: 'historical guidance' }, createdAt: 200,
    });
    const withHistoricalInput = projectWorkItemDetail(detail);
    expect(withHistoricalInput.actions[0]).toMatchObject({ messageCount: 2, messageCursor: '2' });

    detail.currentActionId = null;
    const latest = projectWorkItemDetail(detail);
    expect(latest.actions[99].liveMessage.text).toHaveLength(16_000);
    expect(latest.actions[0]).not.toHaveProperty('liveMessage');

    detail.id = response.repeat(20);
    detail.title = response.repeat(20);
    detail.goal = response.repeat(20);
    detail.linkedSessionIds = Array.from({ length: 100 }, () => response);
    const minimal = projectWorkItemDetail(detail);
    const minimalEvent = projectWorkCenterEvent({ type: response, workItem: detail });
    expect(Buffer.byteLength(JSON.stringify(minimal), 'utf8'))
      .toBeLessThanOrEqual(MAX_WORK_ITEM_BROWSER_DTO_BYTES);
    expect(Buffer.byteLength(JSON.stringify(minimalEvent), 'utf8'))
      .toBeLessThanOrEqual(MAX_WORK_ITEM_BROWSER_DTO_BYTES);
  });

  it('keeps the live assistant message stable across progress and terminal detail projections', () => {
    const detail = internalDetail();
    detail.runs = [{
      id: 'run-live', actionId: 'a-1', status: 'running', startedAt: 10,
      response: 'Reading the relevant files', progressRevision: 12,
    }];

    const live = projectWorkCenterEvent({ type: 'run.progress', workItem: detail });
    expect(live.workItem.actionStats[0].liveMessage).toEqual({
      id: 'run:run-live', role: 'assistant', kind: 'response', status: 'running',
      text: 'Reading the relevant files', attachments: [], createdAt: 10, updatedAt: 10,
      progressRevision: 12,
    });

    detail.runs[0] = {
      ...detail.runs[0], status: 'completed', endedAt: 20,
      response: 'Implemented and verified the fix', progressRevision: 13,
    };
    const terminal = projectWorkItemDetail(detail).actions[0];
    expect(terminal.liveMessage).toMatchObject({
      id: 'run:run-live', status: 'completed', text: 'Implemented and verified the fix',
      progressRevision: 13,
    });
    expect(terminal.messages.filter(message => message.id === 'run:run-live')).toEqual([
      expect.objectContaining({
        status: 'completed', text: 'Implemented and verified the fix', progressRevision: 13,
      }),
    ]);
  });

  it('projects a bounded, sanitized failure reason for failed Work Item and Action detail', () => {
    const detail = internalDetail();
    detail.status = 'needs_attention';
    detail.actions[0].status = 'failed';
    detail.runs[0] = {
      ...detail.runs[0], status: 'failed',
      error: 'Request https://user:pass@example.com/private?token=secret failed in /home/alice/private/project with api_key=top-secret',
    };

    const projected = projectWorkItemDetail(detail);
    expect(projected.failureReason).toBe('The Action failed. Sensitive details were omitted.');
    expect(projected.actions[0].failureReason).toBe(projected.failureReason);
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
    const projected = projectWorkItemDetail(detail);
    expect(projected.failureReason).toBe('The Action failed. Sensitive details were omitted.');
    expect(JSON.stringify(projected)).not.toContain(error);
  });

  it('keeps a safe multiline failure reason bounded and strips URL credentials, query, and fragment', () => {
    const detail = internalDetail();
    detail.status = 'needs_attention';
    detail.actions[0].status = 'failed';
    detail.runs[0] = {
      ...detail.runs[0], status: 'failed',
      error: `Upstream https://user:pass@example.com/v1/jobs?token=secret#private returned 503\n${'safe context '.repeat(300)}`,
    };
    const failure = projectWorkItemDetail(detail).failureReason;
    expect(failure).toContain('Upstream https://example.com/v1/jobs returned 503\n');
    expect(failure.length).toBe(2_000);
    expect(failure).not.toMatch(/user:pass|token=secret|#private/);
  });

  it('does not expose a stale work-item failure reason after success', () => {
    const detail = internalDetail();
    detail.status = 'done';
    detail.actions[0].status = 'completed';
    detail.runs[0].status = 'completed';
    detail.runs[1].error = 'Earlier attempt failed';
    const projected = projectWorkItemDetail(detail);
    expect(projected.failureReason).toBe('');
    expect(projected.actions[0].failureReason).toBe('');
  });

});
