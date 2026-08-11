import { afterEach, describe, expect, it, vi } from 'vitest';
import { folderPickerData, folderPickerMethods } from '../../web/components/mixins/folder-picker-mixin.js';

function createPicker() {
  const sendWsMessage = vi.fn(() => true);
  const picker = {
    ...folderPickerData(),
    folderPickerAgentId: 'agent-1',
    defaultWorkDir: '/agent/default',
    chat: { sendWsMessage },
    folderPickerInitialDir: () => '/projects/yeaft',
    folderPickerSetWorkDir: vi.fn(),
    ...folderPickerMethods,
  };
  return { picker, sendWsMessage };
}

describe('Session create directory picker', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the Agent-scoped pre-Session directory picker protocol', () => {
    vi.useFakeTimers();
    const { picker, sendWsMessage } = createPicker();

    picker.openFolderPicker();

    expect(sendWsMessage).toHaveBeenCalledTimes(1);
    expect(sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'list_directory',
      conversationId: '_workdir_picker',
      directoryPickerScope: 'agent',
      requestId: expect.stringMatching(/^folder-picker-/),
      agentId: 'agent-1',
      dirPath: '/projects/yeaft',
    }));
    expect(sendWsMessage.mock.calls[0][0]).not.toHaveProperty('workbenchRoute');
    expect(sendWsMessage.mock.calls[0][0]).not.toHaveProperty('workDir');
  });

  it('ignores a late directory response after the picker is cancelled', () => {
    vi.useFakeTimers();
    const { picker, sendWsMessage } = createPicker();
    picker.openFolderPicker();
    const requestId = sendWsMessage.mock.calls[0][0].requestId;

    picker.closeFolderPicker();
    picker.handleFolderPickerMessage({ detail: {
      type: 'directory_listing',
      conversationId: '_workdir_picker',
      directoryPickerScope: 'agent',
      requestId,
      agentId: 'agent-1',
      dirPath: '/projects/late',
      entries: [{ name: 'late', type: 'directory' }],
    } });
    vi.advanceTimersByTime(5000);

    expect(picker.folderPickerOpen).toBe(false);
    expect(picker.folderPickerEntries).toEqual([]);
    expect(picker.folderPickerPath).toBe('/projects/yeaft');
    expect(sendWsMessage).toHaveBeenCalledTimes(1);
  });
});
