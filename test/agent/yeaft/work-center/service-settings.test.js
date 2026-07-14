import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
import { projectWorkItemDetail } from '../../../../agent/yeaft/work-center/projection.js';
import { defaultWorkCenterSettings } from '../../../../agent/yeaft/work-center/workflow.js';

const services = [];
const dirs = [];
async function createService(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'work-center-service-'));
  dirs.push(dir);
  const service = new WorkCenterService({
    yeaftDir: dir,
    runner: null,
    runtimeInfoProvider: async () => ({
      vps: [{ id: 'linus', name: 'Linus' }],
      models: [{ id: 'model', ref: 'provider/model', provider: 'provider', effortOptions: ['medium', 'high'] }],
      primaryModel: 'provider/model',
      fastModel: null,
      defaultWorkDir: dir,
    }),
    ...overrides,
  });
  services.push(service);
  return service;
}

afterEach(async () => {
  while (services.length) await services.pop().shutdown();
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('Work Center settings service', () => {
  it('serves and persists Agent-local settings through generic operations', async () => {
    const service = await createService();
    const initial = await service.handle('get_settings');
    expect(initial.settings.defaultWorkflowId).toBe('software-change');
    expect(initial.settings.globalInstructions).toBe('');
    expect(initial.settings.workflows[0].stages[0].instruction).toContain('Do not implement');
    expect(initial.runtime.vps[0].id).toBe('linus');
    expect(initial.runtime.defaultStageInstructions.implement).toContain('add or update focused tests');
    expect(initial.runtime.workItemTypes).toEqual([
      { id: 'software-change', name: 'Software change', actionCount: 4 },
    ]);

    const next = defaultWorkCenterSettings();
    next.defaultWorkDir = '/project';
    next.globalInstructions = 'Apply the Agent release policy to every Action.';
    const saved = await service.handle('update_settings', { settings: next });
    expect(saved.settings.defaultWorkDir).toBe('/project');
    expect(saved.settings.globalInstructions).toBe('Apply the Agent release policy to every Action.');
    expect(saved.settings.revision).toBe(2);
    expect((await service.handle('get_settings')).settings).toMatchObject({
      defaultWorkDir: '/project',
      globalInstructions: 'Apply the Agent release policy to every Action.',
    });
  });

  it('persists WorkItem attachments with the item and returns only safe browser metadata', async () => {
    const service = await createService();
    const detail = await service.handle('create', {
      title: 'Inspect evidence', goal: 'Use the uploaded evidence in every Action', workDir: '/tmp', start: false,
      files: [{
        name: '../evidence.txt', mimeType: 'text/plain', data: Buffer.from('persistent evidence').toString('base64'),
      }],
    });
    const stored = service.store.getWorkItem(detail.id);
    const projected = projectWorkItemDetail(detail);

    expect(projected.attachments).toEqual([expect.objectContaining({
      name: 'evidence.txt', mimeType: 'text/plain', size: 19, isImage: false,
    })]);
    expect(JSON.stringify(projected.attachments)).not.toContain('storageName');
    expect(JSON.stringify(projected.attachments)).not.toContain('sha256');
    expect(stored.attachments).toEqual([expect.objectContaining({
      name: 'evidence.txt', storageName: expect.any(String), sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
  });

  it('appends guidance attachments and exposes their bytes only through the preview operation', async () => {
    const service = await createService();
    const created = await service.handle('create', {
      title: 'Inspect evidence', goal: 'Use additional evidence', workDir: '/tmp', start: true,
    });
    const guided = await service.handle('guide', {
      id: created.id,
      guidance: '',
      actionId: created.currentActionId,
      revision: created.revision,
      files: [{
        name: 'screen.png', mimeType: 'image/png', data: Buffer.from('image bytes').toString('base64'),
      }],
    });

    expect(guided.status).toBe('ready');
    expect(guided.attachments).toEqual([expect.objectContaining({ name: 'screen.png', isImage: true })]);
    expect(guided.actions.at(-1).instruction).toContain('The user added 1 attachment(s)');
    const preview = await service.handle('preview_attachment', {
      id: created.id,
      attachmentId: guided.attachments[0].id,
    });
    expect(preview).toMatchObject({
      attachment: { name: 'screen.png', isImage: true },
      previewData: { data: Buffer.from('image bytes').toString('base64'), mimeType: 'image/png' },
    });
  });

  it('removes a newly created attachment directory when stale guidance is rejected', async () => {
    const service = await createService();
    const created = await service.handle('create', {
      title: 'Reject stale guidance', goal: 'Do not leave orphaned files', workDir: '/tmp', start: true,
    });

    await expect(service.handle('guide', {
      id: created.id,
      guidance: 'stale',
      actionId: 'wrong-action',
      revision: created.revision,
      files: [{
        name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('orphan').toString('base64'),
      }],
    })).rejects.toThrow(/Action changed/);

    expect(existsSync(join(service.attachmentRoot, created.id))).toBe(false);
    expect(service.store.getWorkItem(created.id).attachments).toEqual([]);
  });

  it('keeps committed attachment metadata and files when the post-commit watcher step fails', async () => {
    const service = await createService();
    const created = await service.handle('create', {
      title: 'Keep committed guidance', goal: 'Preserve committed attachment state', workDir: '/tmp', start: true,
    });
    service.watcher.abortInvalidWorkItemRuns = () => { throw new Error('watcher failed after commit'); };

    await expect(service.handle('guide', {
      id: created.id,
      guidance: '',
      actionId: created.currentActionId,
      revision: created.revision,
      files: [{
        name: 'evidence.txt', mimeType: 'text/plain', data: Buffer.from('committed evidence').toString('base64'),
      }],
    })).rejects.toThrow('watcher failed after commit');

    const stored = service.store.getWorkItem(created.id);
    expect(stored.attachments).toEqual([expect.objectContaining({ name: 'evidence.txt' })]);
    expect(existsSync(join(service.attachmentRoot, created.id, stored.attachments[0].storageName))).toBe(true);
  });

  it('removes persisted attachments through the secure cleanup path when WorkItem creation fails', async () => {
    const service = await createService({
      controller: {
        create() { throw new Error('database create failed'); },
      },
    });

    await expect(service.handle('create', {
      title: 'Fail after persistence', goal: 'Verify cleanup', workDir: '/tmp', start: false,
      files: [{
        name: 'evidence.txt', mimeType: 'text/plain', data: Buffer.from('evidence').toString('base64'),
      }],
    })).rejects.toThrow('database create failed');

    expect(existsSync(service.attachmentRoot)).toBe(true);
    expect(readdirSync(service.attachmentRoot)).toEqual([]);
  });

  it('canonicalizes an omitted runtime directory default before creating', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'work-center-runtime-'));
    dirs.push(runtimeDir);
    const service = await createService({
      runtimeInfoProvider: async () => ({ defaultWorkDir: runtimeDir }),
    });

    const omitted = await service.handle('create', {
      title: 'Legacy default', goal: 'Keep omitted-field compatibility', start: false,
    });
    const stored = service.store.getWorkItem(omitted.id);

    expect(stored.workDir).toBe(realpathSync(runtimeDir));
    expect(stored.workspaceKey).toBe(realpathSync(runtimeDir));
  });

  it('prefers the saved directory default over the runtime default', async () => {
    const savedDir = mkdtempSync(join(tmpdir(), 'work-center-saved-'));
    dirs.push(savedDir);
    const service = await createService();
    const settings = defaultWorkCenterSettings();
    settings.defaultWorkDir = savedDir;
    await service.handle('update_settings', { settings });

    const omitted = await service.handle('create', {
      title: 'Saved default', goal: 'Keep settings compatibility', start: false,
    });
    const stored = service.store.getWorkItem(omitted.id);

    expect(stored.workDir).toBe(realpathSync(savedDir));
    expect(stored.workspaceKey).toBe(realpathSync(savedDir));
  });

  it.each([
    ['', 'blank'],
    ['   ', 'whitespace'],
    [null, 'null'],
    [42, 'non-string'],
    ['/definitely/missing/work-center-directory', 'missing'],
  ])('rejects an explicit %s workDir without create side effects', async (workDir) => {
    const emitted = [];
    const service = await createService({ onEvent: event => emitted.push(event) });

    await expect(service.handle('create', {
      title: 'Unsafe directory', goal: 'Do not create incomplete workspace identity', workDir, start: false,
    })).rejects.toThrow(/workDir/);

    expect(service.store.listWorkItems({})).toEqual([]);
    expect(service.store.db.prepare('SELECT COUNT(*) AS count FROM actions').get().count).toBe(0);
    expect(service.store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count).toBe(0);
    expect(emitted).toEqual([]);
  });

  it('loads Action request indexes and details only through the owning WorkItem and Action', async () => {
    const trace = {
      fetchRecentDebugHistory: async options => {
        if (options.indexOnly) {
          return {
            turns: [{
              turnId: 'request-1', openedAt: 10, closedAt: 20, loopCount: 1,
              totalMs: 10, totalTokens: 30, summaryInputTokens: 20, summaryOutputTokens: 10,
            }],
            loops: [],
          };
        }
        return {
          turns: [{
            turnId: 'request-1', openedAt: 10, closedAt: 20, loopCount: 1,
            totalMs: 10, totalTokens: 30, tools: [],
          }],
          loops: [{
            loopInstanceId: 'loop-1', loopNumber: 1, model: 'provider/model',
            systemPrompt: 'system', messages: [], response: 'done', usage: { totalTokens: 30 },
            latencyMs: 10, toolCalls: [], requestBase: { rawRequest: { headers: { Authorization: 'secret' } } },
          }],
        };
      },
      close: async () => {},
    };
    const runner = { trace };
    const service = await createService({ runner });
    const item = await service.handle('create', {
      title: 'Debug task', goal: 'Inspect requests', workDir: '/tmp', start: true,
    });
    const claim = service.store.claimReadyAction('boot', 5_000);
    service.store.setRunExecutionSnapshots(claim.run.id, 'boot', claim.run.leaseEpoch, {
      roleSnapshot: { id: 'triage' }, vpSnapshot: { id: 'omni', name: 'Omni' },
      modelSnapshot: { id: 'provider/model' }, toolPolicySnapshot: {},
    });

    const index = await service.handle('get_action_requests', {
      id: item.id, actionId: claim.action.id,
    });
    expect(index.requests).toEqual([expect.objectContaining({
      id: 'request-1', runId: claim.run.id, model: 'provider/model', totalTokens: 30,
    })]);
    const detail = await service.handle('get_action_request', {
      id: item.id, actionId: claim.action.id, runId: claim.run.id, requestId: 'request-1',
    });
    expect(detail.request.loops[0].rawRequest.headers.Authorization).toBe('***');
    await expect(service.handle('get_action_request', {
      id: item.id, actionId: 'missing', runId: claim.run.id, requestId: 'request-1',
    })).rejects.toThrow(/Action not found/);
  });

  it('returns the redacted browser detail DTO from the real get operation', async () => {
    const service = await createService();
    const item = await service.handle('create', {
      title: 'Redacted task', goal: 'Keep snapshots private', workDir: '/tmp', start: true,
    });
    const claim = service.store.claimReadyAction('boot', 5_000);
    service.store.setRunExecutionSnapshots(claim.run.id, 'boot', claim.run.leaseEpoch, {
      roleSnapshot: { id: 'triage', actionType: 'triage', selectionReason: 'auto:triage' },
      vpSnapshot: { id: 'omni', name: 'Omni', persona: 'secret persona', personaHash: 'secret-hash' },
      modelSnapshot: { id: 'provider/model', provider: 'provider' },
      toolPolicySnapshot: {
        allowedToolNames: ['FileRead'], readRoots: ['/private/read'], writeRoots: ['/private/write'],
        shell: { fixedCwd: '/private/cwd' },
      },
    });
    const detail = await service.handle('get', { id: item.id });
    expect(detail.actions[0]).toMatchObject({ loopCount: 0, toolCount: 0 });
    expect(detail).not.toHaveProperty('runs');
    expect(detail).not.toHaveProperty('events');
    const wire = JSON.stringify(detail);
    for (const secret of ['/tmp', 'secret persona', 'secret-hash', 'provider/model', 'allowedToolNames', '/private/read', '/private/write', '/private/cwd']) {
      expect(wire).not.toContain(secret);
    }
  });

  it('creates an AI-planned WorkItem without a caller-defined workflow', async () => {
    const service = await createService();
    const item = await service.handle('create', {
      title: 'Dynamic task', goal: 'Choose the best task-specific flow', workDir: '/tmp', start: false,
      stageOverrides: {
        implement: {
          assignmentPolicy: { mode: 'fixed', fixedVpId: 'caller-choice' },
          modelPolicy: { mode: 'specific', model: 'caller/model', effort: 'max' },
        },
      },
    });

    expect(item).toMatchObject({ workflowTemplate: 'ai-planned', status: 'draft' });
    expect(item.workflowSnapshot).toMatchObject({ id: 'ai-planned', planningMode: 'ai', globalInstructions: '' });
    expect(item.workflowSnapshot.stages.map(stage => stage.id)).toEqual(['triage']);
    expect(JSON.stringify(item.workflowSnapshot)).not.toContain('caller-choice');
    expect(JSON.stringify(item.workflowSnapshot)).not.toContain('caller/model');
  });

  it('uses an explicit reusable Work Item type without running LLM triage', async () => {
    const service = await createService();
    const item = await service.handle('create', {
      title: 'Typed change', goal: 'Use the reusable software change template',
      workItemType: 'software-change', workDir: '/tmp', start: false,
    });

    expect(item).toMatchObject({ workflowTemplate: 'ai-planned', status: 'draft' });
    expect(item.workflowSnapshot).toMatchObject({
      id: 'software-change', workItemType: 'software-change', planningMode: 'static',
    });
    expect(item.workflowSnapshot.stages.map(stage => stage.type))
      .toEqual(['triage', 'implement', 'review', 'deliver']);
  });

  it('freezes an explicit custom Work Item type for LLM planning', async () => {
    const service = await createService();
    const item = await service.handle('create', {
      title: 'Incident response', goal: 'Plan the smallest incident response flow',
      workItemType: 'incident-response', workDir: '/tmp', start: false,
    });

    expect(item.workflowSnapshot).toMatchObject({
      id: 'ai-planned', workItemType: 'incident-response', planningMode: 'ai',
    });
    expect(item.workflowSnapshot.stages.map(stage => stage.type)).toEqual(['triage']);
  });

  it('freezes the effective workflow and stage overrides for trusted explicit legacy producers', async () => {
    const service = await createService();
    const item = await service.handle('create', {
      title: 'Configurable task',
      goal: 'Use a fixed implementation VP and model',
      workDir: '/tmp',
      start: false,
      workflowTemplate: 'software-change',
      stageOverrides: {
        implement: {
          assignmentPolicy: { mode: 'fixed', fixedVpId: 'linus' },
          modelPolicy: { mode: 'specific', model: 'provider/model', effort: 'high' },
        },
      },
    }, { trustedProducer: true });
    expect(item.workflowSnapshot.id).toBe('software-change');
    expect(item.workflowSnapshot.stages.find(stage => stage.id === 'implement')).toMatchObject({
      assignmentPolicy: { mode: 'fixed', fixedVpId: 'linus' },
      modelPolicy: { mode: 'specific', model: 'provider/model', effort: 'high' },
    });

    const changed = defaultWorkCenterSettings();
    changed.workflows[0].stages.find(stage => stage.id === 'implement').assignmentPolicy = {
      mode: 'fixed', capability: 'implement', fixedVpId: 'someone-else', candidateVpIds: [], separateFromStageTypes: [],
    };
    await service.handle('update_settings', { settings: changed });
    expect(service.store.getWorkItem(item.id).workflowSnapshot.stages
      .find(stage => stage.id === 'implement').assignmentPolicy.fixedVpId).toBe('linus');
  });

  it('ignores explicit workflow and stage overrides from untrusted callers', async () => {
    const service = await createService();
    const item = await service.handle('create', {
      title: 'Untrusted configurable task',
      goal: 'Do not accept caller execution policy',
      workDir: '/tmp',
      start: false,
      workflowTemplate: 'software-change',
      stageOverrides: {
        implement: {
          assignmentPolicy: { mode: 'fixed', fixedVpId: 'caller-choice' },
          modelPolicy: { mode: 'specific', model: 'caller/model', effort: 'max' },
        },
      },
    });

    expect(item).toMatchObject({ workflowTemplate: 'ai-planned' });
    expect(item.workflowSnapshot.stages.map(stage => stage.id)).toEqual(['triage']);
    expect(JSON.stringify(item.workflowSnapshot)).not.toContain('caller-choice');
    expect(JSON.stringify(item.workflowSnapshot)).not.toContain('caller/model');
  });
});
