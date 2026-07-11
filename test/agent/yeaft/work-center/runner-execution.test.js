import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Registry } from '../../../../agent/yeaft/vp/registry.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';

const engineOptions = [];
let invalidEngineResult = false;
vi.mock('../../../../agent/yeaft/engine.js', () => ({
  Engine: class {
    constructor(options) { engineOptions.push(options); }
    async *query() {
      yield { type: 'loop', loopNumber: 1 };
      yield { type: 'tool_end', id: 'tool-1', name: 'FileRead', output: 'ok', isError: false };
      yield { type: 'loop', loopNumber: 2 };
      yield { text: invalidEngineResult ? 'not-json' : JSON.stringify({
        outcome: 'completed', summary: 'done', evidence: [], reviewDecision: 'approved',
      }) };
    }
    abort() {}
  },
}));

const { WorkItemRunner } = await import('../../../../agent/yeaft/work-center/runner.js');

let workDir;
afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
  engineOptions.length = 0;
  invalidEngineResult = false;
});

describe('Work Center Runner execution resolution', () => {
  it('runs a guidance-restarted policy Action with its frozen VP and model policy', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'work-center-guidance-runner-'));
    const store = new WorkItemStore(join(workDir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const assignmentPolicy = {
      mode: 'pool', capability: 'triage', candidateVpIds: ['omni'], fixedVpId: null,
      separateFromStageTypes: [],
    };
    const modelPolicy = { mode: 'specific', model: 'provider/review', effort: 'high' };
    const workflowSnapshot = {
      version: 1, id: 'policy', name: 'Policy', stages: [{
        id: 'analysis-one', name: 'Analysis', type: 'triage', instruction: '', maxAttempts: 2,
        assignmentPolicy, modelPolicy,
      }],
    };
    const item = controller.create({
      title: 'Guided policy task', goal: 'Keep the policy', acceptanceCriteria: [],
      workflowTemplate: 'policy', workflowSnapshot, workDir, start: true,
    });
    const first = store.claimReadyAction('boot-1', 5_000);
    controller.guide(item.id, {
      guidance: 'Keep the frozen execution policy', actionId: first.action.id, revision: item.revision,
    });
    const guided = store.claimReadyAction('boot-1', 5_000);
    const registry = new Registry();
    registry.setVp({
      id: 'omni', name: 'Omni', role: 'Triage Lead', traits: ['triage'], modelHint: 'primary',
      persona: 'Triage', personaHash: 'hash',
    });
    const runner = new WorkItemRunner({
      registry,
      store,
      runtimeProvider: async () => ({
        adapter: {},
        config: {
          primaryModel: 'provider/primary', fallbackModel: 'provider/fallback',
          availableModels: [
            { id: 'review', ref: 'provider/review', provider: 'provider', effortOptions: ['high'] },
          ],
        },
      }),
    });
    try {
      const result = await runner.run({
        workItem: store.getWorkItem(item.id), action: guided.action, run: guided.run,
        ownerBootId: 'boot-1', signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ outcome: 'completed' });
      expect(guided.action).toMatchObject({ stageId: 'analysis-one', assignmentPolicy, modelPolicy });
      expect(engineOptions[0]).toMatchObject({
        vpId: 'omni',
        config: { model: 'provider/review', modelEffort: 'high', fallbackModel: null },
      });
    } finally {
      store.close();
    }
  });

  it('persists the actual VP, Provider, model, effort, and selection reason before execution', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'work-center-runner-'));
    const registry = new Registry();
    registry.setVp({
      id: 'martin', name: 'Martin', role: 'Code Reviewer', traits: ['review', 'readability'],
      modelHint: 'primary', persona: 'Review independently', personaHash: 'hash',
    });
    registry.setVp({
      id: 'linus', name: 'Linus', role: 'Systems Engineer', traits: ['implementation'],
      modelHint: 'primary', persona: 'Implement', personaHash: 'hash',
    });
    const snapshots = vi.fn().mockReturnValue(true);
    const store = {
      listCompletedRuns: vi.fn().mockReturnValue([
        { actionType: 'implement', vpSnapshot: { id: 'linus' }, roleSnapshot: { actionType: 'implement' } },
      ]),
      isActiveRun: vi.fn().mockReturnValue(true),
      setRunExecutionSnapshots: snapshots,
    };
    const runner = new WorkItemRunner({
      registry,
      store,
      runtimeProvider: async () => ({
        adapter: {},
        config: {
          primaryModel: 'provider/primary',
          fallbackModel: 'provider/fallback',
          availableModels: [
            { id: 'primary', ref: 'provider/primary', provider: 'provider', effortOptions: [] },
            { id: 'review', ref: 'provider/review', provider: 'provider', effortOptions: ['high'] },
            { id: 'fallback', ref: 'provider/fallback', provider: 'provider', effortOptions: [] },
          ],
        },
      }),
    });
    const result = await runner.run({
      workItem: { id: 'wi-1', workDir, workspaceKey: workDir },
      action: {
        type: 'review', stageId: 'review', instruction: 'Review it',
        assignmentPolicy: {
          mode: 'auto', capability: 'review', candidateVpIds: [], fixedVpId: null,
          separateFromStageTypes: ['implement'],
        },
        modelPolicy: { mode: 'specific', model: 'provider/review', effort: 'high' },
      },
      run: { id: 'run-1', leaseEpoch: 2 },
      ownerBootId: 'boot-1',
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'completed', summary: 'done', loopCount: 2, toolCount: 1,
    });
    expect(snapshots).toHaveBeenCalledWith('run-1', 'boot-1', 2, expect.objectContaining({
      roleSnapshot: expect.objectContaining({
        id: 'review', actionType: 'review', selectionReason: expect.stringMatching(/^auto:review/),
      }),
      vpSnapshot: expect.objectContaining({ id: 'martin' }),
      modelSnapshot: {
        id: 'provider/review', provider: 'provider', effort: 'high', source: 'stage-specific',
        policy: { mode: 'specific', model: 'provider/review', effort: 'high' },
      },
    }));
    expect(engineOptions[0]).toMatchObject({
      config: { model: 'provider/review', modelEffort: 'high', fallbackModel: null },
      vpId: 'martin',
    });
  });

  it('clears the Agent effort when the frozen stage policy uses the model default', async () => {
    const registry = new Registry();
    registry.setVp({
      id: 'linus', name: 'Linus', role: 'Systems Engineer', traits: ['implementation'],
      modelHint: 'primary', persona: 'Implement', personaHash: 'hash',
    });
    const snapshots = vi.fn().mockReturnValue(true);
    const store = {
      listCompletedRuns: vi.fn().mockReturnValue([]),
      isActiveRun: vi.fn().mockReturnValue(true),
      setRunExecutionSnapshots: snapshots,
    };
    const runner = new WorkItemRunner({
      registry,
      store,
      runtimeProvider: async () => ({
        adapter: {},
        config: {
          primaryModel: 'provider/primary',
          modelEffort: 'high',
          availableModels: [
            { id: 'plain', ref: 'provider/plain', provider: 'provider', effortOptions: [] },
          ],
        },
      }),
    });

    await runner.run({
      workItem: { id: 'wi-1' },
      action: {
        type: 'implement', stageId: 'implement', instruction: 'Implement it',
        requiredRole: 'linus',
        modelPolicy: { mode: 'specific', model: 'provider/plain', effort: null },
      },
      run: { id: 'run-1', leaseEpoch: 1 },
      ownerBootId: 'boot-1',
      signal: new AbortController().signal,
    });

    expect(snapshots).toHaveBeenCalledWith('run-1', 'boot-1', 1, expect.objectContaining({
      modelSnapshot: expect.objectContaining({ id: 'provider/plain', effort: null }),
    }));
    expect(engineOptions[0]).toMatchObject({
      config: { model: 'provider/plain', modelEffort: null, fallbackModel: null },
    });
  });

  it('preserves aggregate counts when the structured result is invalid', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'work-center-invalid-result-'));
    invalidEngineResult = true;
    const registry = new Registry();
    registry.setVp({
      id: 'linus', name: 'Linus', role: 'Developer', traits: ['implement'], modelHint: 'primary',
      persona: 'Implement', personaHash: 'hash',
    });
    const runner = new WorkItemRunner({
      registry,
      store: {
        listCompletedRuns: vi.fn().mockReturnValue([]),
        isActiveRun: vi.fn().mockReturnValue(true),
        setRunExecutionSnapshots: vi.fn().mockReturnValue(true),
      },
      runtimeProvider: async () => ({
        adapter: {},
        config: { primaryModel: 'provider/model', availableModels: [] },
      }),
    });

    await expect(runner.run({
      workItem: { id: 'wi-1', workDir, workspaceKey: workDir },
      action: { type: 'implement', requiredRole: 'linus', instruction: 'Implement it' },
      run: { id: 'run-1', leaseEpoch: 1 },
      ownerBootId: 'boot-1',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ outcome: 'failed', loopCount: 2, toolCount: 1 });
  });
});
