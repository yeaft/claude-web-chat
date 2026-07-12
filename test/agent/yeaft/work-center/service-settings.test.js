import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
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
    expect(initial.settings.workflows[0].stages[0].instruction).toContain('Do not implement yet');
    expect(initial.runtime.vps[0].id).toBe('linus');
    expect(initial.runtime.defaultStageInstructions.implement).toContain('Add and run relevant tests');

    const next = defaultWorkCenterSettings();
    next.defaultWorkDir = '/project';
    const saved = await service.handle('update_settings', { settings: next });
    expect(saved.settings.defaultWorkDir).toBe('/project');
    expect(saved.settings.revision).toBe(2);
    expect((await service.handle('get_settings')).settings.defaultWorkDir).toBe('/project');
  });

  it('uses a directory default only when legacy callers omit workDir', async () => {
    const service = await createService();
    const settings = defaultWorkCenterSettings();
    settings.defaultWorkDir = '/tmp';
    await service.handle('update_settings', { settings });

    const omitted = await service.handle('create', {
      title: 'Legacy default', goal: 'Keep omitted-field compatibility', start: false,
    });
    const explicitBlank = await service.handle('create', {
      title: 'Explicit blank', goal: 'Do not hide a directory choice', workDir: '', start: false,
    });

    expect(service.store.getWorkItem(omitted.id).workDir).toBe('/tmp');
    expect(service.store.getWorkItem(explicitBlank.id).workDir).toBe('');
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
    expect(item.workflowSnapshot).toMatchObject({ id: 'ai-planned', planningMode: 'ai' });
    expect(item.workflowSnapshot.stages.map(stage => stage.id)).toEqual(['triage']);
    expect(JSON.stringify(item.workflowSnapshot)).not.toContain('caller-choice');
    expect(JSON.stringify(item.workflowSnapshot)).not.toContain('caller/model');
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
