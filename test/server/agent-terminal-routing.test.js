import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendToWebClient: vi.fn(),
  forwardToClients: vi.fn(),
  webClients: new Map(),
}));

vi.mock('../../server/context.js', () => ({
  previewFiles: new Map(),
  webClients: mocks.webClients,
}));

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient: mocks.sendToWebClient,
  forwardToClients: mocks.forwardToClients,
  setCachedDir: vi.fn(),
  invalidateParentDirCache: vi.fn(),
  clearAgentDirCache: vi.fn(),
}));

const { handleAgentFileTerminal } = await import('../../server/handlers/agent-file-terminal.js');

describe('Agent terminal response routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.webClients.clear();
  });

  it('returns Yeaft virtual terminal output to the requesting browser', async () => {
    const client = { authenticated: true, userId: 'user-a' };
    mocks.webClients.set('client-a', client);

    await handleAgentFileTerminal('agent-a', {}, {
      type: 'terminal_output',
      conversationId: 'yeaft-123',
      terminalId: 'term-1',
      data: 'hello',
      _requestClientId: 'client-a',
      _requestUserId: 'user-a',
    });

    expect(mocks.sendToWebClient).toHaveBeenCalledWith(client, {
      type: 'terminal_output',
      conversationId: 'yeaft-123',
      terminalId: 'term-1',
      data: 'hello',
    });
    expect(mocks.forwardToClients).not.toHaveBeenCalled();
  });

  it('does not send a terminal response to a recycled client id owned by another user', async () => {
    mocks.webClients.set('client-a', { authenticated: true, userId: 'user-b' });
    const msg = {
      type: 'terminal_created',
      conversationId: 'yeaft-123',
      terminalId: 'term-1',
      success: true,
      _requestClientId: 'client-a',
      _requestUserId: 'user-a',
    };

    await handleAgentFileTerminal('agent-a', {}, msg);

    expect(mocks.sendToWebClient).not.toHaveBeenCalled();
    expect(mocks.forwardToClients).toHaveBeenCalledWith('agent-a', 'yeaft-123', msg);
  });
});
