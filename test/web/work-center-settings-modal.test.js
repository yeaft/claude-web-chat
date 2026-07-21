// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import WorkCenterPage from '../../web/components/WorkCenterPage.js';
import WorkCenterSettingsModal, {
  normalizeSettingsDraft,
  supportsDynamicSettings,
} from '../../web/components/WorkCenterSettingsModal.js';
import {
  defaultWorkCenterStageInstruction,
  normalizeWorkCenterSettings,
} from '../../agent/yeaft/work-center/workflow.js';

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
    normalizeDraftEffort: vi.fn(),
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
      globalInstructions: 'Apply this policy to every Action.',
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
    expect(draft.globalInstructions).toBe('Apply this policy to every Action.');
    expect(draft.actionInstructions).toMatchObject({
      triage: 'Inspect the legacy task.',
      implement: 'Keep the legacy implementation prompt.',
      review: 'Review the result.',
      custom: 'Complete the Action.',
    });
    expect(draft.actionInstructions.design).toBe('');
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
    expect(stages).toHaveLength(15);
    expect(stages[0].querySelector('textarea').value).toBe('');
    expect(stages[0].querySelector('textarea').disabled).toBe(true);
    expect(stages[1].querySelector('textarea').value).toBe('Legacy triage prompt.');
    expect(stages[1].querySelector('textarea').disabled).toBe(true);
    expect(stages[5].querySelector('textarea').value).toBe('Implement the task.');
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
        'triage', 'research', 'design', 'diagnose', 'implement', 'migrate', 'test', 'review',
        'document', 'operate', 'deliver', 'write', 'custom',
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

  it('accepts a modern Agent canonical response and uses its advanced revision', async () => {
    const draft = normalizeWorkCenterSettings({
      revision: 3,
      modelPolicy: { mode: 'specific', model: 'provider/new', effort: 'low' },
    });
    draft.actionInstructions.triage = '   ';
    draft.modelPolicy.model = '  provider/new  ';
    const saved = normalizeWorkCenterSettings({ ...structuredClone(draft), revision: 4 });
    const store = { saveWorkCenterSettings: vi.fn().mockResolvedValue({ settings: saved }) };
    const vm = modalVm({ draft, store, defaultStageInstructions: {} });

    await WorkCenterSettingsModal.methods.save.call(vm);

    expect(saved.actionInstructions.triage).toBe(defaultWorkCenterStageInstruction('triage'));
    expect(saved.modelPolicy.model).toBe('provider/new');
    expect(vm.error).toBe('');
    expect(vm.draft.revision).toBe(4);
    expect(vm.draft.actionInstructions.triage).toBe(defaultWorkCenterStageInstruction('triage'));
    expect(vm.draft.modelPolicy.model).toBe('provider/new');
    expect(vm.$emit).toHaveBeenCalledWith('saved', saved);
    expect(vm.$emit).toHaveBeenCalledWith('close');
  });

  it('does not close when a complete save response fails to advance revision', async () => {
    const draft = normalizeWorkCenterSettings({ revision: 3 });
    const saved = normalizeWorkCenterSettings({ ...structuredClone(draft), revision: 3 });
    const store = { saveWorkCenterSettings: vi.fn().mockResolvedValue({ settings: saved }) };
    const vm = modalVm({ draft, store, defaultStageInstructions: {} });

    await WorkCenterSettingsModal.methods.save.call(vm);

    expect(vm.settingsUnsupported).toBe(false);
    expect(vm.error).toBe('workCenter.settings.saveNotConfirmed');
    expect(vm.draft.revision).toBe(3);
    expect(vm.$emit).not.toHaveBeenCalledWith('saved', expect.anything());
    expect(vm.$emit).not.toHaveBeenCalledWith('close');
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

  it('uses only the resolved model effort options and explains unavailable effort', () => {
    const stage = { modelPolicy: { mode: 'primary', model: null, effort: 'low' } };
    const vm = modalVm({
      runtime: { primaryModel: 'provider/primary', fastModel: 'provider/fast' },
      models: [
        { ref: 'provider/review', effortOptions: ['medium', 'high'] },
        { ref: 'provider/plain', effortOptions: [] },
        { ref: 'provider/primary', effortOptions: ['low', 'medium', 'high'] },
      ],
    });
    vm.modelRefForStage = WorkCenterSettingsModal.methods.modelRefForStage.bind(vm);
    vm.modelForStage = WorkCenterSettingsModal.methods.modelForStage.bind(vm);
    vm.effortOptionsForStage = WorkCenterSettingsModal.methods.effortOptionsForStage.bind(vm);
    vm.effortHelpKeyForStage = WorkCenterSettingsModal.methods.effortHelpKeyForStage.bind(vm);
    expect(vm.effortOptionsForStage(stage)).toEqual(['low', 'medium', 'high']);
    expect(vm.effortHelpKeyForStage(stage)).toBe('workCenter.settings.effortHelp');

    stage.modelPolicy.mode = 'inherit';
    expect(vm.effortOptionsForStage(stage)).toEqual(['medium', 'high', 'low']);
    expect(vm.effortHelpKeyForStage(stage)).toBe('workCenter.settings.effortChooseModelHelp');
    WorkCenterSettingsModal.methods.normalizeStageEffort.call(vm, stage);
    expect(stage.modelPolicy.effort).toBe('low');

    stage.modelPolicy.mode = 'specific';
    stage.modelPolicy.model = 'provider/plain';
    expect(vm.effortHelpKeyForStage(stage)).toBe('workCenter.settings.effortUnsupportedHelp');

    stage.modelPolicy.model = 'provider/review';
    expect(vm.effortOptionsForStage(stage)).toEqual(['medium', 'high']);
    WorkCenterSettingsModal.methods.normalizeStageEffort.call(vm, stage);
    expect(stage.modelPolicy.effort).toBeNull();
  });

  it('shows only Action prompts and model policy in settings', () => {
    const vm = modalVm({ $t: key => key });
    const sections = WorkCenterSettingsModal.computed.sections.call(vm);
    expect(sections.map(section => section.id)).toEqual(['workflow', 'models']);
    expect(WorkCenterSettingsModal.template).not.toContain('draft.defaultWorkDir');
    expect(WorkCenterSettingsModal.template).not.toContain('draft.startImmediately');
  });

  it('backfills delayed create defaults without overriding user input', () => {
    const vm = {
      createOpen: false,
      workDirTouched: false,
      startTouched: false,
      createDefaultWorkDir: '',
      createDefaultStart: false,
      settings: { startImmediately: false },
      form: { workDir: '', start: true },
    };
    vm.applyCreateDefaults = WorkCenterPage.methods.applyCreateDefaults.bind(vm);

    WorkCenterPage.methods.openCreate.call(vm);
    expect(vm.form).toMatchObject({ workDir: '', start: false });

    vm.createDefaultWorkDir = '/workspace/default';
    WorkCenterPage.watch.createDefaultWorkDir.call(vm);
    expect(vm.form.workDir).toBe('/workspace/default');

    WorkCenterPage.methods.folderPickerSetWorkDir.call(vm, '/workspace/chosen');
    vm.createDefaultWorkDir = '/workspace/changed';
    WorkCenterPage.watch.createDefaultWorkDir.call(vm);
    expect(vm.form.workDir).toBe('/workspace/chosen');
  });

  it('preserves a manually entered work directory when delayed defaults arrive', () => {
    const vm = {
      createOpen: true,
      workDirTouched: false,
      startTouched: false,
      createDefaultWorkDir: '',
      createDefaultStart: true,
      form: { workDir: '/workspace/manual', start: true },
    };
    vm.applyCreateDefaults = WorkCenterPage.methods.applyCreateDefaults.bind(vm);

    WorkCenterPage.methods.onCreateWorkDirInput.call(vm);
    vm.createDefaultWorkDir = '/workspace/default';
    WorkCenterPage.watch.createDefaultWorkDir.call(vm);

    expect(vm.workDirTouched).toBe(true);
    expect(vm.form.workDir).toBe('/workspace/manual');
  });

  it('waits for the new Agent defaults before replacing untouched execution input', async () => {
    const vm = {
      createOpen: true,
      workDirTouched: false,
      startTouched: false,
      createDefaultWorkDir: '',
      createDefaultStart: true,
      form: {
        workDir: '/workspace/a', start: false, title: 'Keep title', goal: 'Keep goal',
        acceptanceCriteriaText: '', reuseMemory: true,
      },
      selectedId: 'item-a',
      agentId: 'agent-b',
      saving: false,
      settings: { startImmediately: true },
      closeFolderPicker: vi.fn(),
      store: {
        workCenterCreateDraft: {
          sourceAgentId: 'agent-a',
          title: 'Keep title',
          goal: 'Keep goal',
          origin: { sessionId: 'session-a', messageId: null, createdBy: 'user' },
          linkedSessionIds: ['session-a'],
        },
        listWorkItems: vi.fn().mockResolvedValue([]),
        loadWorkCenterSettings: vi.fn().mockResolvedValue({}),
        createWorkItem: vi.fn().mockResolvedValue({ id: 'item-b' }),
      },
    };
    vm.applyCreateDefaults = WorkCenterPage.methods.applyCreateDefaults.bind(vm);
    vm.resetCreateExecutionContext = WorkCenterPage.methods.resetCreateExecutionContext.bind(vm);

    WorkCenterPage.watch.agentId.handler.call(vm, 'agent-b', 'agent-a');

    expect(vm.createOpen).toBe(true);
    expect(vm.form).toMatchObject({
      workDir: '', start: true, title: 'Keep title', goal: 'Keep goal',
    });
    expect(vm.store.workCenterCreateDraft).toMatchObject({
      sourceAgentId: 'agent-b', origin: null, linkedSessionIds: [],
    });
    expect(vm.store.listWorkItems).toHaveBeenCalledWith('agent-b');
    expect(vm.store.loadWorkCenterSettings).toHaveBeenCalledWith('agent-b');

    vm.createDefaultWorkDir = '/workspace/b';
    WorkCenterPage.watch.createDefaultWorkDir.call(vm);
    vm.createDefaultStart = false;
    WorkCenterPage.watch.createDefaultStart.call(vm);

    expect(vm.form).toMatchObject({
      workDir: '/workspace/b', start: false, title: 'Keep title', goal: 'Keep goal',
    });

    await WorkCenterPage.methods.submitCreate.call(vm);

    expect(vm.store.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        workDir: '/workspace/b', start: false, origin: null, linkedSessionIds: [],
      }),
      'agent-b',
    );
  });

  it('closes edited execution input instead of carrying it to another Agent', () => {
    const vm = {
      createOpen: true,
      workDirTouched: true,
      startTouched: false,
      createDefaultWorkDir: '/workspace/b',
      createDefaultStart: false,
      form: { workDir: '/workspace/custom-a', start: true, title: 'Keep title', goal: 'Keep goal' },
      closeFolderPicker: vi.fn(),
      selectedId: 'item-a',
      store: {
        workCenterCreateDraft: {
          sourceAgentId: 'agent-a',
          title: 'Keep title',
          goal: 'Keep goal',
          origin: { sessionId: 'session-a', messageId: null, createdBy: 'user' },
          linkedSessionIds: ['session-a'],
        },
        listWorkItems: vi.fn().mockResolvedValue([]),
        loadWorkCenterSettings: vi.fn().mockResolvedValue({}),
      },
    };
    vm.applyCreateDefaults = WorkCenterPage.methods.applyCreateDefaults.bind(vm);

    vm.resetCreateExecutionContext = WorkCenterPage.methods.resetCreateExecutionContext.bind(vm);
    WorkCenterPage.watch.agentId.handler.call(vm, 'agent-b', 'agent-a');

    expect(vm.createOpen).toBe(false);
    expect(vm.form).toMatchObject({ workDir: '', start: true, title: 'Keep title', goal: 'Keep goal' });
    expect(vm.store.workCenterCreateDraft).toMatchObject({
      sourceAgentId: 'agent-b', origin: null, linkedSessionIds: [],
    });
    expect(vm.workDirTouched).toBe(false);

    WorkCenterPage.methods.openCreate.call(vm);
    expect(vm.createOpen).toBe(true);
    expect(vm.store.workCenterCreateDraft.origin).toBeNull();
    expect(vm.store.workCenterCreateDraft.linkedSessionIds).toEqual([]);
  });

  it('drops provenance when a stale draft bypasses the Agent watcher', async () => {
    const vm = {
      agentId: 'agent-b',
      saving: false,
      selectedId: null,
      settings: { startImmediately: true },
      workDirTouched: false,
      startTouched: false,
      createOpen: true,
      workItemAttachmentsSupported: false,
      createAttachments: [{ fileId: 'stale-file', name: 'stale.txt', mimeType: 'text/plain', size: 5 }],
      form: {
        title: 'Keep title', goal: 'Keep goal', acceptanceCriteriaText: '',
        workDir: '/workspace/b', reuseMemory: true, start: false,
      },
      store: {
        workCenterCreateDraft: {
          sourceAgentId: 'agent-a',
          origin: { sessionId: 'session-a', messageId: null, createdBy: 'user' },
          linkedSessionIds: ['session-a'],
        },
        createWorkItem: vi.fn().mockResolvedValue({ id: 'item-b' }),
      },
    };

    await WorkCenterPage.methods.submitCreate.call(vm);

    expect(vm.store.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ origin: null, linkedSessionIds: [], attachments: [] }),
      'agent-b',
    );
  });

  it('clears stale effort after load and before saving without model interaction', async () => {
    const loaded = normalizeWorkCenterSettings({
      revision: 3,
      modelPolicy: { mode: 'specific', model: 'provider/model', effort: 'high' },
    });
    const store = {
      loadWorkCenterSettings: vi.fn().mockResolvedValue({ settings: loaded }),
      saveWorkCenterSettings: vi.fn().mockImplementation(async submitted => ({
        settings: normalizeWorkCenterSettings({ ...structuredClone(submitted), revision: 4 }),
      })),
    };
    const vm = modalVm({
      draft: null,
      store,
      defaultStageInstructions: {},
      runtime: {
        models: [{ ref: 'provider/model', effortOptions: ['medium'] }],
        primaryModel: 'provider/model',
      },
      models: [{ ref: 'provider/model', effortOptions: ['medium'] }],
    });
    vm.modelRefForStage = WorkCenterSettingsModal.methods.modelRefForStage.bind(vm);
    vm.modelForStage = WorkCenterSettingsModal.methods.modelForStage.bind(vm);
    vm.effortOptionsForStage = WorkCenterSettingsModal.methods.effortOptionsForStage.bind(vm);
    vm.normalizeStageEffort = WorkCenterSettingsModal.methods.normalizeStageEffort.bind(vm);
    vm.normalizeDraftEffort = WorkCenterSettingsModal.methods.normalizeDraftEffort.bind(vm);

    await WorkCenterSettingsModal.methods.load.call(vm);
    expect(vm.draft.modelPolicy.effort).toBeNull();
    await WorkCenterSettingsModal.methods.save.call(vm);

    expect(store.saveWorkCenterSettings).toHaveBeenCalledWith(
      expect.objectContaining({ modelPolicy: expect.objectContaining({ effort: null }) }),
      'agent-a',
    );
  });

  it('clears effort when refreshed runtime removes its capability', () => {
    const vm = modalVm({
      draft: { modelPolicy: { mode: 'specific', model: 'provider/model', effort: 'high' } },
      runtime: { models: [{ ref: 'provider/model', effortOptions: ['medium'] }] },
      models: [{ ref: 'provider/model', effortOptions: ['medium'] }],
    });
    vm.modelRefForStage = WorkCenterSettingsModal.methods.modelRefForStage.bind(vm);
    vm.modelForStage = WorkCenterSettingsModal.methods.modelForStage.bind(vm);
    vm.effortOptionsForStage = WorkCenterSettingsModal.methods.effortOptionsForStage.bind(vm);
    vm.normalizeStageEffort = WorkCenterSettingsModal.methods.normalizeStageEffort.bind(vm);
    vm.normalizeDraftEffort = WorkCenterSettingsModal.methods.normalizeDraftEffort.bind(vm);

    WorkCenterSettingsModal.watch.runtime.handler.call(vm);

    expect(vm.draft.modelPolicy.effort).toBeNull();
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
