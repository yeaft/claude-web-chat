import { describe, expect, it, vi } from 'vitest';
import { folderPickerData, folderPickerMethods } from '../../web/components/mixins/folder-picker-mixin.js';
import WorkCenterPage from '../../web/components/WorkCenterPage.js';

function createPicker(agentId = 'agent-a') {
  const sent = [];
  const vm = {
    ...folderPickerData(),
    folderPickerAgentId: agentId,
    defaultWorkDir: '/workspace',
    chat: { sendWsMessage: message => sent.push(message) },
    folderPickerInitialDir: () => '/workspace',
    folderPickerSetWorkDir: vi.fn(),
  };
  for (const [name, method] of Object.entries(folderPickerMethods)) {
    vm[name] = method.bind(vm);
  }
  return { vm, sent };
}

describe('folder picker request scoping', () => {
  it('accepts only the current request for the current Agent', () => {
    const { vm, sent } = createPicker();
    vm.openFolderPicker();
    const requestA = sent.at(-1);

    vm.folderPickerAgentId = 'agent-b';
    vm.loadFolderPickerDir('/agent-b');
    const requestB = sent.at(-1);

    expect(requestA.requestId).toBeTruthy();
    expect(requestB.requestId).toBeTruthy();
    expect(requestB.requestId).not.toBe(requestA.requestId);
    expect(requestB.agentId).toBe('agent-b');

    vm.handleFolderPickerMessage({ detail: {
      type: 'directory_listing', conversationId: '_workdir_picker',
      requestId: requestA.requestId, dirPath: '/agent-a',
      entries: [{ name: 'old', type: 'directory' }],
    } });
    expect(vm.folderPickerPath).toBe('/workspace');
    expect(vm.folderPickerEntries).toEqual([]);

    vm.handleFolderPickerMessage({ detail: {
      type: 'directory_listing', conversationId: '_workdir_picker',
      requestId: requestB.requestId, dirPath: '/agent-b',
      entries: [{ name: 'current', type: 'directory' }],
    } });
    expect(vm.folderPickerPath).toBe('/agent-b');
    expect(vm.folderPickerEntries).toEqual([{ name: 'current', type: 'directory' }]);
  });

  it('invalidates a pending request when the picker closes', () => {
    const { vm, sent } = createPicker();
    vm.openFolderPicker();
    const request = sent.at(-1);

    vm.closeFolderPicker();
    vm.handleFolderPickerMessage({ detail: {
      type: 'directory_listing', conversationId: '_workdir_picker',
      requestId: request.requestId, dirPath: '/late',
      entries: [{ name: 'late', type: 'directory' }],
    } });

    expect(vm.folderPickerOpen).toBe(false);
    expect(vm.folderPickerPath).toBe('/workspace');
    expect(vm.folderPickerEntries).toEqual([]);
  });

  it('closes and invalidates the picker when Work Center changes Agent', () => {
    const vm = {
      selectedId: 'item-a',
      closeFolderPicker: vi.fn(),
      resetCreateExecutionContext: vi.fn(),
      store: {
        listWorkItems: vi.fn().mockResolvedValue([]),
        loadWorkCenterSettings: vi.fn().mockResolvedValue({}),
      },
    };

    WorkCenterPage.watch.agentId.handler.call(vm, 'agent-b', 'agent-a');

    expect(vm.closeFolderPicker).toHaveBeenCalledOnce();
    expect(vm.resetCreateExecutionContext).toHaveBeenCalledWith('agent-b');
  });
});
