import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Registry } from '../../../../agent/yeaft/vp/registry.js';

const engineOptions = [];
vi.mock('../../../../agent/yeaft/engine.js', () => ({
  Engine: class {
    constructor(options) { engineOptions.push(options); }
    async *query() {
      yield { text: JSON.stringify({
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
});

describe('Work Center Runner execution resolution', () => {
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
          availableModels: [
            { id: 'primary', ref: 'provider/primary', provider: 'provider' },
            { id: 'review', ref: 'provider/review', provider: 'provider' },
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

    expect(result).toMatchObject({ outcome: 'completed', summary: 'done' });
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
      config: { model: 'provider/review', modelEffort: 'high' },
      vpId: 'martin',
    });
  });
});
