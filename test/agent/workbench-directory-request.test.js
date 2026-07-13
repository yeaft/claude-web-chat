import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendToServer: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock('fs/promises', async importOriginal => ({
  ...await importOriginal(),
  readdir: mocks.readdir,
}));

vi.mock('../../agent/context.js', () => ({
  default: {
    conversations: new Map(),
    CONFIG: { workDir: '/' },
    sendToServer: mocks.sendToServer,
  },
}));

const { handleListDirectory } = await import('../../agent/workbench/file-ops.js');

describe('Agent directory request correlation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readdir.mockResolvedValue([]);
  });

  it('echoes requestId on successful directory listings', async () => {
    await handleListDirectory({
      conversationId: '_workdir_picker',
      requestId: 'picker-request-a',
      dirPath: '/',
      workDir: '/',
      _requestClientId: 'client-a',
    });

    expect(mocks.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'directory_listing',
      conversationId: '_workdir_picker',
      requestId: 'picker-request-a',
      _requestClientId: 'client-a',
    }));
  });

  it('echoes requestId when root directory enumeration fails', async () => {
    mocks.readdir.mockRejectedValueOnce(new Error('root unavailable'));

    await handleListDirectory({
      conversationId: '_workdir_picker',
      requestId: 'picker-request-error',
      dirPath: '',
      workDir: '/',
      _requestClientId: 'client-a',
    });

    expect(mocks.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'directory_listing',
      conversationId: '_workdir_picker',
      requestId: 'picker-request-error',
      _requestClientId: 'client-a',
      dirPath: '',
      entries: [],
      error: 'root unavailable',
    }));
  });
});
