// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import WorkCenterSettingsModal, {
  normalizeSettingsDraft,
  supportsDynamicSettings,
} from '../../web/components/WorkCenterSettingsModal.js';

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
    settingsUnsupported: false,
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
  afterEach(() => {
    delete globalThis.Pinia;
    document.body.innerHTML = '';
  });

  it('migrates missing dynamic settings from an older workflow response', () => {
    const draft = normalizeSettingsDraft({
      revision: 7,
      defaultWorkflowId: 'software-change',
      workflows: [{
        id: 'software-change',
        stages: [
          {
            id: 'triage',
            type: 'triage',
            instruction: 'Inspect the legacy task.',
            modelPolicy: { mode: 'specific', model: 'provider/legacy', effort: 'high' },
          },
          { id: 'implement', type: 'implement', instruction: 'Keep the legacy implementation prompt.' },
        ],
      }],
    }, {
      review: 'Review the result.',
      custom: 'Complete the Action.',
    });

    expect(draft.revision).toBe(7);
    expect(draft.actionInstructions).toMatchObject({
      triage: 'Inspect the legacy task.',
      implement: 'Keep the legacy implementation prompt.',
      review: 'Review the result.',
      custom: 'Complete the Action.',
    });
    expect(draft.modelPolicy).toEqual({
      mode: 'specific', model: 'provider/legacy', effort: 'high',
    });
    expect(supportsDynamicSettings(draft)).toBe(true);
    expect(supportsDynamicSettings({ workflows: draft.workflows })).toBe(false);
  });

  it('renders cached settings without actionInstructions while refresh is pending', async () => {
    const legacySettings = {
      revision: 3,
      defaultWorkflowId: 'software-change',
      workflows: [{
        id: 'software-change',
        stages: [{ id: 'triage', type: 'triage', instruction: 'Legacy triage prompt.' }],
      }],
    };
    const store = {
      workCenterSettingsByAgent: { 'agent-a': legacySettings },
      workCenterRuntimeByAgent: {
        'agent-a': {
          defaultStageInstructions: {
            implement: 'Implement the task.',
            custom: 'Complete the Action.',
          },
        },
      },
      loadWorkCenterSettings: vi.fn().mockReturnValue(new Promise(() => {})),
      saveWorkCenterSettings: vi.fn(),
    };
    globalThis.Pinia = { useChatStore: () => store };
    const errors = [];
    const wrapper = mount(WorkCenterSettingsModal, {
      props: { agentId: 'agent-a' },
      global: {
        mocks: {
          $t: key => key,
          $i18n: { locale: 'en' },
        },
        config: {
          errorHandler: error => errors.push(error),
        },
      },
      attachTo: document.body,
    });

    await Vue.nextTick();

    const stages = [...document.body.querySelectorAll('.work-center-policy-stage')];
    expect(errors).toEqual([]);
    expect(stages).toHaveLength(8);
    expect(stages[0].querySelector('textarea').value).toBe('Legacy triage prompt.');
    expect(stages[0].querySelector('textarea').disabled).toBe(true);
    expect(stages[1].querySelector('textarea').value).toBe('Implement the task.');
    expect(document.body.querySelector('.work-center-settings-footer .btn-primary').disabled).toBe(true);
    expect(store.saveWorkCenterSettings).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('keeps successful legacy settings responses read-only instead of silently losing edits', async () => {
    const store = {
      loadWorkCenterSettings: vi.fn().mockResolvedValue({
        settings: {
          revision: 3,
          defaultWorkflowId: 'software-change',
          workflows: [{
            id: 'software-change',
            stages: [{ id: 'triage', type: 'triage', instruction: 'Legacy prompt.' }],
          }],
        },
      }),
      saveWorkCenterSettings: vi.fn(),
    };
    const vm = modalVm({ draft: null, store, defaultStageInstructions: {} });

    await WorkCenterSettingsModal.methods.load.call(vm);
    await WorkCenterSettingsModal.methods.save.call(vm);

    expect(vm.settingsUnsupported).toBe(true);
    expect(vm.error).toBe('workCenter.settings.upgradeRequired');
    expect(vm.draft.actionInstructions.triage).toBe('Legacy prompt.');
    expect(store.saveWorkCenterSettings).not.toHaveBeenCalled();
    expect(vm.$emit).not.toHaveBeenCalledWith('close');
  });

  it('does not close when a save response drops submitted dynamic settings', async () => {
    const draft = normalizeSettingsDraft({
      revision: 3,
      modelPolicy: { mode: 'specific', model: 'provider/new', effort: 'low' },
      actionInstructions: Object.fromEntries([
        'triage', 'implement', 'test', 'review', 'deliver', 'research', 'write', 'custom',
      ].map(type => [type, type === 'triage' ? 'Edited triage.' : `Edited ${type}.`])),
    });
    const store = {
      saveWorkCenterSettings: vi.fn().mockResolvedValue({
        settings: {
          revision: 4,
          defaultWorkflowId: 'software-change',
          workflows: [{
            id: 'software-change',
            stages: [{
              id: 'triage',
              type: 'triage',
              instruction: 'Legacy triage.',
              modelPolicy: { mode: 'specific', model: 'provider/old', effort: 'high' },
            }],
          }],
        },
      }),
    };
    const vm = modalVm({ draft, store, defaultStageInstructions: {} });

    await WorkCenterSettingsModal.methods.save.call(vm);

    expect(store.saveWorkCenterSettings).toHaveBeenCalledOnce();
    expect(vm.settingsUnsupported).toBe(true);
    expect(vm.error).toBe('workCenter.settings.upgradeRequired');
    expect(vm.draft.actionInstructions.triage).toBe('Edited triage.');
    expect(vm.$emit).not.toHaveBeenCalledWith('saved', expect.anything());
    expect(vm.$emit).not.toHaveBeenCalledWith('close');
  });

  it('closes only after a modern Agent confirms the submitted dynamic settings', async () => {
    const draft = normalizeSettingsDraft({
      revision: 3,
      modelPolicy: { mode: 'specific', model: 'provider/new', effort: 'low' },
      actionInstructions: Object.fromEntries([
        'triage', 'implement', 'test', 'review', 'deliver', 'research', 'write', 'custom',
      ].map(type => [type, `Prompt for ${type}.`])),
    });
    const saved = { ...structuredClone(draft), revision: 4 };
    const store = { saveWorkCenterSettings: vi.fn().mockResolvedValue({ settings: saved }) };
    const vm = modalVm({ draft, store, defaultStageInstructions: {} });

    await WorkCenterSettingsModal.methods.save.call(vm);

    expect(vm.error).toBe('');
    expect(vm.draft.revision).toBe(4);
    expect(vm.$emit).toHaveBeenCalledWith('saved', saved);
    expect(vm.$emit).toHaveBeenCalledWith('close');
  });

  it('does not save a draft loaded for a different Agent', async () => {
    const vm = modalVm({ agentId: 'agent-b', draftAgentId: 'agent-a' });
    await WorkCenterSettingsModal.methods.save.call(vm);
    expect(vm.store.saveWorkCenterSettings).not.toHaveBeenCalled();
    expect(vm.conflict).toBe(true);
    expect(vm.error).toBe('workCenter.settings.conflict');
  });

  it('shows the default workflow when an older Agent does not support settings', async () => {
    const vm = modalVm({
      draft: null,
      store: {
        loadWorkCenterSettings: vi.fn().mockRejectedValue(
          new Error('Unsupported Work Center operation: get_settings'),
        ),
        saveWorkCenterSettings: vi.fn(),
      },
    });

    await WorkCenterSettingsModal.methods.load.call(vm);

    expect(vm.settingsUnsupported).toBe(true);
    expect(vm.error).toBe('workCenter.settings.upgradeRequired');
    expect(vm.draft).toMatchObject({
      revision: 1,
      defaultWorkflowId: 'software-change',
      startImmediately: true,
      defaultWorkDir: '',
    });
    expect(vm.draft.workflows[0].stages.map(stage => stage.id))
      .toEqual(['triage', 'implement', 'review', 'deliver']);
    await WorkCenterSettingsModal.methods.save.call(vm);
    expect(vm.store.saveWorkCenterSettings).not.toHaveBeenCalled();
  });

  it.each([
    'Unsupported Work Center operation: get_settings_backup',
    'Request failed: Unsupported Work Center operation: get_settings',
    'Unsupported Work Center operation: get_settings (remote failure)',
  ])('does not hide a real settings error as an older Agent fallback: %s', async message => {
    const vm = modalVm({
      draft: null,
      store: {
        loadWorkCenterSettings: vi.fn().mockRejectedValue(new Error(message)),
        saveWorkCenterSettings: vi.fn(),
      },
    });

    await WorkCenterSettingsModal.methods.load.call(vm);

    expect(vm.settingsUnsupported).toBe(false);
    expect(vm.error).toBe(message);
    expect(vm.draft).toBeNull();
  });

  it('accepts surrounding whitespace on the exact older Agent error', async () => {
    const vm = modalVm({
      draft: null,
      store: {
        loadWorkCenterSettings: vi.fn().mockRejectedValue(
          new Error('  Unsupported Work Center operation: get_settings\n'),
        ),
        saveWorkCenterSettings: vi.fn(),
      },
    });

    await WorkCenterSettingsModal.methods.load.call(vm);

    expect(vm.settingsUnsupported).toBe(true);
    expect(vm.draft?.defaultWorkflowId).toBe('software-change');
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

  it('restores the executable default prompt for the selected stage type', () => {
    const stage = { type: 'implement', instruction: 'Custom prompt' };
    const vm = modalVm({
      defaultStageInstructions: {
        implement: 'Implement the smallest correct change.',
        custom: 'Complete this stage.',
      },
    });
    vm.defaultInstructionForStage = WorkCenterSettingsModal.methods.defaultInstructionForStage.bind(vm);

    WorkCenterSettingsModal.methods.resetStageInstruction.call(vm, stage);

    expect(stage.instruction).toBe('Implement the smallest correct change.');
  });

  it('updates a default prompt when the stage type changes without overwriting a custom prompt', () => {
    const vm = modalVm({
      defaultStageInstructions: {
        triage: 'Default triage.',
        implement: 'Default implement.',
        custom: 'Default custom.',
      },
    });
    vm.defaultInstructionForStage = WorkCenterSettingsModal.methods.defaultInstructionForStage.bind(vm);
    vm.resetStageInstruction = WorkCenterSettingsModal.methods.resetStageInstruction.bind(vm);
    const stage = { type: 'triage', instruction: 'Default triage.' };

    WorkCenterSettingsModal.methods.setStageType.call(vm, stage, 'implement');
    expect(stage).toMatchObject({ type: 'implement', instruction: 'Default implement.' });

    stage.instruction = 'Keep this custom prompt.';
    WorkCenterSettingsModal.methods.setStageType.call(vm, stage, 'triage');
    expect(stage).toMatchObject({ type: 'triage', instruction: 'Keep this custom prompt.' });
  });

  it('uses only the resolved model effort options and clears unsupported values', () => {
    const stage = { modelPolicy: { mode: 'primary', model: null, effort: 'low' } };
    const vm = modalVm({
      runtime: { primaryModel: 'provider/primary', fastModel: 'provider/fast' },
      models: [
        { ref: 'provider/review', effortOptions: ['medium', 'high'] },
        { ref: 'provider/primary', effortOptions: ['low', 'medium', 'high'] },
      ],
    });
    vm.modelRefForStage = WorkCenterSettingsModal.methods.modelRefForStage.bind(vm);
    vm.effortOptionsForStage = WorkCenterSettingsModal.methods.effortOptionsForStage.bind(vm);
    expect(vm.effortOptionsForStage(stage)).toEqual(['low', 'medium', 'high']);
    stage.modelPolicy.mode = 'inherit';
    expect(vm.effortOptionsForStage(stage)).toEqual([]);
    stage.modelPolicy.mode = 'specific';
    stage.modelPolicy.model = 'provider/review';
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
