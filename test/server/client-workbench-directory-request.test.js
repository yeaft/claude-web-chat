import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendToWebClient: vi.fn(),
  forwardToAgent: vi.fn(),
  getCachedDir: vi.fn(),
}));

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient: mocks.sendToWebClient,
  forwardToAgent: mocks.forwardToAgent,
  getCachedDir: mocks.getCachedDir,
  verifyConversationOwnership: vi.fn(() => true),
}));

const { handleClientWorkbench } = await import('../../server/handlers/client-workbench.js');

describe('client workbench directory request correlation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns requestId on a cached directory listing', async () => {
    mocks.getCachedDir.mockReturnValue([{ name: 'src', type: 'directory' }]);
    const client = { currentAgent: 'agent-a', currentConversation: 'session-a', userId: 'user-a' };

    await handleClientWorkbench('client-a', client, {
      type: 'list_directory',
      conversationId: '_workdir_picker',
      requestId: 'picker-request-a',
      agentId: 'agent-a',
      dirPath: '/workspace',
    }, vi.fn().mockResolvedValue(true));

    expect(mocks.sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      type: 'directory_listing',
      conversationId: '_workdir_picker',
      requestId: 'picker-request-a',
      dirPath: '/workspace',
      fromCache: true,
    }));
    expect(mocks.forwardToAgent).not.toHaveBeenCalled();
  });

  it('forwards requestId to the Agent on a cache miss', async () => {
    mocks.getCachedDir.mockReturnValue(null);

    await handleClientWorkbench('client-a', { currentAgent: 'agent-a', userId: 'user-a' }, {
      type: 'list_directory',
      conversationId: '_workdir_picker',
      requestId: 'picker-request-b',
      agentId: 'agent-a',
      dirPath: '/workspace',
      workDir: '/workspace',
    }, vi.fn().mockResolvedValue(true));

    expect(mocks.forwardToAgent).toHaveBeenCalledWith('agent-a', expect.objectContaining({
      type: 'list_directory',
      requestId: 'picker-request-b',
      _requestClientId: 'client-a',
    }));
  });
});
