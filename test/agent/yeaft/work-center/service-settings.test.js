import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
