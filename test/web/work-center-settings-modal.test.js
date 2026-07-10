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
