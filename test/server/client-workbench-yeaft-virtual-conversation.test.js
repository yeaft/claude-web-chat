import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendToWebClient: vi.fn(),
  forwardToAgent: vi.fn(),
  getCachedDir: vi.fn(),
  verifyConversationOwnership: vi.fn(() => false),
}));

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient: mocks.sendToWebClient,
  forwardToAgent: mocks.forwardToAgent,
  getCachedDir: mocks.getCachedDir,
  verifyConversationOwnership: mocks.verifyConversationOwnership,
}));

// Force the auth path: with skipAuth=true the ownership branch is dead code
// and these tests would pass vacuously.
vi.mock('../../server/config.js', () => ({
  CONFIG: { skipAuth: false },
}));

const { handleClientWorkbench } = await import('../../server/handlers/client-workbench.js');

describe('client workbench with yeaft virtual conversation ids', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyConversationOwnership.mockReturnValue(false);
  });

  it('forwards terminal_create for a yeaft virtual conversationId without ownership lookup', async () => {
    const client = { currentAgent: 'agent-a', userId: 'user-a' };

    await handleClientWorkbench('client-a', client, {
      type: 'terminal_create',
      agentId: 'agent-a',
      conversationId: 'yeaft-1752541234567',
      terminalId: 'term-1',
      cols: 80,
      rows: 24,
    }, vi.fn().mockResolvedValue(true));

    expect(mocks.forwardToAgent).toHaveBeenCalledWith('agent-a', expect.objectContaining({
      type: 'terminal_create',
      conversationId: 'yeaft-1752541234567',
      terminalId: 'term-1',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));
    // The virtual id has no DB row / in-memory conversation — the handler
    // must not consult verifyConversationOwnership at all.
    expect(mocks.verifyConversationOwnership).not.toHaveBeenCalled();
    expect(mocks.sendToWebClient).not.toHaveBeenCalled();
  });

  it('forwards terminal_input for the store-local yeaft id (pre session_ready)', async () => {
    const client = { currentAgent: 'agent-a', userId: 'user-a' };

    await handleClientWorkbench('client-a', client, {
      type: 'terminal_input',
      agentId: 'agent-a',
      conversationId: 'yeaft-local-1752541234567',
      terminalId: 'term-1',
      data: 'ls\r',
    }, vi.fn().mockResolvedValue(true));

    expect(mocks.forwardToAgent).toHaveBeenCalledWith('agent-a', expect.objectContaining({
      type: 'terminal_input',
      conversationId: 'yeaft-local-1752541234567',
    }));
    expect(mocks.sendToWebClient).not.toHaveBeenCalled();
  });

  it('still denies terminal_create for a foreign chat conversation', async () => {
    const client = { currentAgent: 'agent-a', userId: 'user-b' };

    await handleClientWorkbench('client-b', client, {
      type: 'terminal_create',
      agentId: 'agent-a',
      conversationId: 'chat-conversation-owned-by-user-a',
      terminalId: 'term-2',
    }, vi.fn().mockResolvedValue(true));

    expect(mocks.verifyConversationOwnership).toHaveBeenCalledWith('chat-conversation-owned-by-user-a', 'user-b');
    expect(mocks.forwardToAgent).not.toHaveBeenCalled();
    expect(mocks.sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      type: 'error',
      message: 'Permission denied',
    }));
  });

  it('treats write_file with a yeaft virtual id as an agent-level write', async () => {
    const client = { currentAgent: 'agent-a', userId: 'user-a' };

    await handleClientWorkbench('client-a', client, {
      type: 'write_file',
      agentId: 'agent-a',
      conversationId: 'yeaft-1752541234567',
      filePath: '/workspace/readme.md',
      content: 'hello',
    }, vi.fn().mockResolvedValue(true));

    expect(mocks.forwardToAgent).toHaveBeenCalledWith('agent-a', expect.objectContaining({
      type: 'write_file',
      conversationId: 'yeaft-1752541234567',
      _requestUserId: 'user-a',
    }));
    expect(mocks.verifyConversationOwnership).not.toHaveBeenCalled();
    expect(mocks.sendToWebClient).not.toHaveBeenCalled();
  });

  it('still denies write_file for a foreign chat conversation', async () => {
    const client = { currentAgent: 'agent-a', userId: 'user-b' };

    await handleClientWorkbench('client-b', client, {
      type: 'write_file',
      agentId: 'agent-a',
      conversationId: 'chat-conversation-owned-by-user-a',
      filePath: '/workspace/readme.md',
      content: 'hello',
    }, vi.fn().mockResolvedValue(true));

    expect(mocks.forwardToAgent).not.toHaveBeenCalled();
    expect(mocks.sendToWebClient).toHaveBeenCalledWith(client, expect.objectContaining({
      type: 'error',
      message: 'Permission denied',
    }));
  });
});
