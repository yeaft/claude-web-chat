import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ctx from '../../../../agent/context.js';

const sendToServer = vi.fn();
const ensureSessionLoaded = vi.fn();
const resetYeaftSession = vi.fn();
vi.mock('../../../../agent/connection/buffer.js', () => ({ sendToServer }));
vi.mock('../../../../agent/yeaft/web-bridge.js', () => ({
  ensureSessionLoaded,
  resetYeaftSession,
}));

const {
  bootWorkCenter,
  createWorkItemFromProducer,
  handleWorkCenterRequest,
  shutdownWorkCenter,
  __testSetWorkCenterFactory,
  __testSetWorkCenterService,
} = await import('../../../../agent/yeaft/work-center/bridge.js');

const originalConfig = ctx.CONFIG;
const dirs = [];

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function createYeaftDir() {
  const dir = mkdtempSync(join(tmpdir(), 'work-center-bridge-'));
  dirs.push(dir);
  ctx.CONFIG = { yeaftDir: dir };
  ensureSessionLoaded.mockResolvedValue({
    config: {
      availableModels: [{ id: 'model', ref: 'provider/model', provider: 'provider' }],
      primaryModel: 'provider/model',
      fastModel: null,
    },
  });
  return dir;
}

function internalDetail() {
  return {
    id: 'wi-1', revision: 3, title: 'Private work', goal: 'Keep internals private',
    acceptanceCriteria: ['Safe browser response'], workflowTemplate: 'software-change',
    workflowSnapshot: { id: 'software-change', stages: [{ id: 'triage' }] },
    status: 'running', currentActionId: 'a-1', currentRunId: 'r-1',
    workDir: '/private/project', workspaceKey: '/private/canonical', reuseMemory: true,
    origin: { sessionId: 'session-1', messageId: 'private-message', createdBy: 'linus' },
    linkedSessionIds: ['session-1'], createdAt: 1, updatedAt: 2,
    actions: [{
      id: 'a-1', workItemId: 'wi-1', sequence: 1, type: 'triage', stageId: 'triage',
      assignmentPolicy: { mode: 'auto', capability: 'triage' },
      modelPolicy: { mode: 'specific', model: 'provider/model' },
      requiredRole: '', instruction: 'private prompt', context: [{ secret: 'private context' }],
      status: 'running', attempt: 1, maxAttempts: 2, currentRunId: 'r-1', createdAt: 1, updatedAt: 2,
    }],
    runs: [{
      id: 'r-1', actionId: 'a-1', workItemId: 'wi-1', status: 'running', startedAt: 1, expiresAt: 2,
      response: 'Analyzed the request and prepared the contract.',
      summary: 'Contract prepared', evidence: [{ kind: 'test', label: 'passed' }],
      loopCount: 3, toolCount: 8, progressRevision: 6,
      roleSnapshot: { id: 'triage', actionType: 'triage', selectionReason: 'auto:triage', assignmentPolicy: { mode: 'auto' } },
      vpSnapshot: { id: 'omni', name: 'Omni', role: 'Lead', persona: 'private persona', personaHash: 'private-hash' },
      modelSnapshot: { id: 'provider/model', provider: 'provider', policy: { mode: 'specific' } },
      toolPolicySnapshot: {
        allowedToolNames: ['FileRead'], readRoots: ['/private/read'], writeRoots: ['/private/write'],
        shell: { fixedCwd: '/private/cwd' },
      },
    }],
    events: [{
      id: 'e-1', workItemId: 'wi-1', actionId: 'a-1', runId: 'r-1',
      type: 'run.started', data: { secret: 'private event data' }, createdAt: 1,
    }],
  };
}

describe('Work Center lifecycle bridge', () => {
  beforeEach(() => {
    sendToServer.mockClear();
    ensureSessionLoaded.mockReset();
    resetYeaftSession.mockReset();
    resetYeaftSession.mockResolvedValue(undefined);
    ctx.CONFIG = originalConfig;
    __testSetWorkCenterService(null);
    __testSetWorkCenterFactory(null);
  });

  afterEach(() => {
    ctx.CONFIG = originalConfig;
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it('serves executable default stage prompts through the browser settings path', async () => {
    createYeaftDir();

    await handleWorkCenterRequest({ requestId: 'settings-1', op: 'get_settings', payload: {} });

    expect(sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'settings-1',
      ok: true,
      data: expect.objectContaining({
        settings: expect.objectContaining({ defaultWorkflowId: 'software-change' }),
        runtime: expect.objectContaining({
          defaultStageInstructions: expect.objectContaining({
            triage: expect.stringContaining('Do not implement yet'),
            implement: expect.stringContaining('Add and run relevant tests'),
          }),
        }),
      }),
    }));
  });

  it('boots the autonomous watcher exactly once', async () => {
    const service = { start: vi.fn(), shutdown: vi.fn() };
    const factory = vi.fn().mockResolvedValue(service);
    __testSetWorkCenterFactory(factory);
    const [first, second] = await Promise.all([bootWorkCenter(), bootWorkCenter()]);
    expect(first).toBe(service);
    expect(second).toBe(service);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledTimes(1);
    await shutdownWorkCenter();
    expect(service.shutdown).toHaveBeenCalledTimes(1);
  });

  it('returns default Agent settings without initializing the WorkItem service', async () => {
    const yeaftDir = createYeaftDir();
    const factory = vi.fn();
    __testSetWorkCenterFactory(factory);

    await handleWorkCenterRequest({
      requestId: 'settings-1', op: 'get_settings', payload: {}, _requestUserId: 'user-1',
    });

    expect(factory).not.toHaveBeenCalled();
    expect(existsSync(join(yeaftDir, 'work-center', 'settings.json'))).toBe(false);
    expect(sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'work_center_response', requestId: 'settings-1', op: 'get_settings', ok: true,
      data: {
        settings: expect.objectContaining({
          revision: 1,
          defaultWorkflowId: 'software-change',
          startImmediately: true,
          defaultWorkDir: '',
          workflows: [expect.objectContaining({ id: 'software-change' })],
        }),
        runtime: expect.objectContaining({
          models: [{ id: 'model', ref: 'provider/model', provider: 'provider' }],
          primaryModel: 'provider/model',
        }),
      },
      _requestUserId: 'user-1',
    }));
  });

  it('persists the first settings update before a WorkItem exists', async () => {
    const yeaftDir = createYeaftDir();
    const factory = vi.fn();
    __testSetWorkCenterFactory(factory);

    await handleWorkCenterRequest({
      requestId: 'settings-read', op: 'get_settings', payload: {}, _requestUserId: 'user-1',
    });
    const initial = sendToServer.mock.calls.at(-1)[0].data.settings;
    await handleWorkCenterRequest({
      requestId: 'settings-write',
      op: 'update_settings',
      payload: { settings: { ...initial, defaultWorkDir: '/project' } },
      _requestUserId: 'user-1',
    });

    expect(factory).not.toHaveBeenCalled();
    expect(existsSync(join(yeaftDir, 'work-center', 'settings.json'))).toBe(true);
    expect(sendToServer.mock.calls.at(-1)[0]).toMatchObject({
      type: 'work_center_response', requestId: 'settings-write', op: 'update_settings', ok: true,
      data: { settings: { revision: 2, defaultWorkDir: '/project' } },
    });
  });

  it.each(['get', 'create', 'update', 'start', 'cancel', 'guide', 'retry'])(
    'projects the %s browser response through the safe detail DTO',
    async (op) => {
      const raw = internalDetail();
      const service = {
        start: vi.fn(),
        shutdown: vi.fn(),
        handle: vi.fn().mockResolvedValue(raw),
      };
      __testSetWorkCenterService(service);

      await handleWorkCenterRequest({
        requestId: `detail-${op}`, op, payload: { id: raw.id }, _requestUserId: 'user-1',
      });

      const response = sendToServer.mock.calls.at(-1)[0];
      expect(response).toMatchObject({
        type: 'work_center_response', requestId: `detail-${op}`, op, ok: true,
        data: {
          id: raw.id,
          actions: [{
            id: 'a-1', assignmentPolicy: { mode: 'auto', fixedVpId: null },
            loopCount: 3, toolCount: 8, progressRevision: 6,
            response: 'Analyzed the request and prepared the contract.',
          }],
        },
      });
      const wire = JSON.stringify(response.data);
      for (const secret of [
        '/private/project', '/private/canonical', 'workflowSnapshot', 'private-message',
        'private prompt', 'private context', 'private persona', 'private-hash',
        'Contract prepared', 'modelSnapshot', 'provider/model', 'runs', 'events',
        'toolPolicySnapshot', 'allowedToolNames', '/private/read', '/private/write', '/private/cwd',
        'private event data',
      ]) {
        expect(wire).not.toContain(secret);
      }
    },
  );

  it('keeps Producer create results internal and unprojected', async () => {
    const raw = internalDetail();
    const service = {
      start: vi.fn(),
      shutdown: vi.fn(),
      handle: vi.fn().mockResolvedValue(raw),
    };
    __testSetWorkCenterService(service);

    const result = await createWorkItemFromProducer({ title: 'Internal', goal: 'Keep raw detail' });
    expect(result).toBe(raw);
    expect(result).toMatchObject({
      workDir: '/private/project',
      workflowSnapshot: { id: 'software-change' },
      runs: [{
        vpSnapshot: { persona: 'private persona' },
        toolPolicySnapshot: { readRoots: ['/private/read'] },
      }],
    });
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('waits for runtime reset before returning refreshed settings', async () => {
    createYeaftDir();
    const gate = deferred();
    resetYeaftSession.mockReturnValue(gate.promise);
    ensureSessionLoaded.mockResolvedValue({
      config: {
        availableModels: [],
        primaryModel: 'new-provider/new-model',
        fastModel: null,
      },
    });
    const factory = vi.fn();
    __testSetWorkCenterFactory(factory);

    const request = handleWorkCenterRequest({
      requestId: 'refresh-1', op: 'refresh_runtime', payload: {}, _requestUserId: 'user-1',
    });
    await Promise.resolve();
    expect(resetYeaftSession).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
    expect(sendToServer).not.toHaveBeenCalled();

    gate.resolve();
    await request;
    expect(factory).not.toHaveBeenCalled();
    expect(sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'work_center_response', requestId: 'refresh-1', op: 'refresh_runtime', ok: true,
      data: {
        settings: expect.objectContaining({ defaultWorkflowId: 'software-change' }),
        runtime: expect.objectContaining({ primaryModel: 'new-provider/new-model' }),
      },
      _requestUserId: 'user-1',
    }));
  });

  it('does not leave a watcher alive when shutdown races initialization', async () => {
    const gate = deferred();
    const service = { start: vi.fn(), shutdown: vi.fn() };
    __testSetWorkCenterFactory(() => gate.promise);
    const boot = bootWorkCenter();
    const shutdown = shutdownWorkCenter();
    gate.resolve(service);
    await expect(boot).rejects.toThrow(/shut down/i);
    await shutdown;
    expect(service.start).not.toHaveBeenCalled();
    expect(service.shutdown).toHaveBeenCalledTimes(1);
  });
});
