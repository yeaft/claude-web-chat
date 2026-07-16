import { describe, expect, it } from 'vitest';
import {
  projectActionMessagePage,
  projectActionRequestDetail,
  projectActionRequestIndex,
  projectWorkCenterEvent,
  projectWorkItemDetail,
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
    expect(terminal.messages.filter(message => message.id === terminal.liveMessage.id)).toHaveLength(1);
  });
});
