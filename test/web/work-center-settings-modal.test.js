import { describe, expect, it, vi } from 'vitest';
import WorkCenterSettingsModal from '../../web/components/WorkCenterSettingsModal.js';

function modalVm(overrides = {}) {
  return {
    agentId: 'agent-a',
    draft: { revision: 1 },
    draftAgentId: 'agent-a',
    loadGeneration: 0,
    loading: false,
    saving: false,
    error: '',
    conflict: false,
    $t: key => key,
    $emit: vi.fn(),
    store: {
      loadWorkCenterSettings: vi.fn(),
      saveWorkCenterSettings: vi.fn(),
    },
    ...overrides,
  };
}

describe('Work Center settings modal ownership', () => {
  it('does not save a draft loaded for a different Agent', async () => {
    const vm = modalVm({ agentId: 'agent-b', draftAgentId: 'agent-a' });
    await WorkCenterSettingsModal.methods.save.call(vm);
    expect(vm.store.saveWorkCenterSettings).not.toHaveBeenCalled();
    expect(vm.conflict).toBe(true);
    expect(vm.error).toBe('workCenter.settings.conflict');
  });

  it('ignores a load response after the Agent changes', async () => {
    let resolve;
    const response = new Promise(done => { resolve = done; });
    const vm = modalVm({
      draft: { revision: 1, marker: 'agent-a' },
      store: { loadWorkCenterSettings: vi.fn().mockReturnValue(response) },
    });
    const load = WorkCenterSettingsModal.methods.load.call(vm);
    vm.agentId = 'agent-b';
    resolve({ settings: { revision: 2, marker: 'late-agent-a' } });
    await load;
    expect(vm.draft).toMatchObject({ marker: 'agent-a' });
  });

  it('prevents deleting the only editable stage before review', () => {
    const stages = [
      { id: 'implement', type: 'implement' },
      { id: 'review', type: 'review', changesRequestedStageId: 'implement' },
      { id: 'deliver', type: 'deliver' },
    ];
    const vm = modalVm({ defaultWorkflow: { stages } });
    vm.canRemoveStage = WorkCenterSettingsModal.methods.canRemoveStage.bind(vm);
    expect(WorkCenterSettingsModal.methods.removeStage.call(vm, 0)).toBe(false);
    expect(stages.map(stage => stage.id)).toEqual(['implement', 'review', 'deliver']);
    expect(WorkCenterSettingsModal.methods.reviewReturnCandidates.call(vm, stages[1]))
      .toEqual([stages[0]]);
  });

  it('uses only the selected model effort options and clears unsupported values', () => {
    const stage = { modelPolicy: { mode: 'specific', model: 'provider/review', effort: 'low' } };
    const vm = modalVm({
      runtime: { primaryModel: 'provider/primary', fastModel: 'provider/fast' },
      models: [
        { ref: 'provider/review', effortOptions: ['medium', 'high'] },
        { ref: 'provider/primary', effortOptions: [] },
      ],
    });
    vm.modelRefForStage = WorkCenterSettingsModal.methods.modelRefForStage.bind(vm);
    vm.effortOptionsForStage = WorkCenterSettingsModal.methods.effortOptionsForStage.bind(vm);
    expect(vm.effortOptionsForStage(stage)).toEqual(['medium', 'high']);
    WorkCenterSettingsModal.methods.normalizeStageEffort.call(vm, stage);
    expect(stage.modelPolicy.effort).toBeNull();
  });

  it('turns a revision conflict into an explicit reload state', async () => {
    const vm = modalVm({
      store: {
        saveWorkCenterSettings: vi.fn().mockRejectedValue(
          new Error('Work Center settings changed elsewhere; reload before saving'),
        ),
      },
    });
    await WorkCenterSettingsModal.methods.save.call(vm);
    expect(vm.conflict).toBe(true);
    expect(vm.error).toBe('workCenter.settings.conflict');
    expect(vm.$emit).not.toHaveBeenCalledWith('close');
  });
});
