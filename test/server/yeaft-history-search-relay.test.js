import { afterEach, describe, expect, it, vi } from 'vitest';

const forwardToAgent = vi.fn(async () => {});
const getForAgent = vi.fn(() => ({ id: 'sess-1', agentId: 'agent-1', userId: 'owner-1' }));

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient: vi.fn(),
  forwardToAgent,
  broadcastAgentList: vi.fn(),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: { get: vi.fn(() => null) },
  messageDb: {},
  userDb: {},
  yeaftSessionDb: { getByUser: vi.fn(() => []), getForAgent },
}));

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(() => false),
}));

const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');
const allow = async () => true;
const client = { userId: 'owner-1', username: 'u', currentAgent: 'wrong-agent' };

afterEach(() => {
  forwardToAgent.mockClear();
  getForAgent.mockClear();
  getForAgent.mockReturnValue({ id: 'sess-1', agentId: 'agent-1', userId: 'owner-1' });
});

describe('Yeaft Session history search relay', () => {
  it('relays bounded outline pages with explicit compound identity', async () => {
    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_history_outline',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'outline-1',
      limit: 50,
      beforeSeq: 42,
      includeTotal: false,
    }, allow);

    expect(getForAgent).toHaveBeenCalledWith('owner-1', 'agent-1', 'sess-1');
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'yeaft_load_history_outline',
      sessionId: 'sess-1',
      requestId: 'outline-1',
      limit: 50,
      beforeSeq: 42,
      includeTotal: false,
      _requestClientId: 'client-1',
    }));
  });

  it('requires explicit compound identity and targets the requesting client', async () => {
    await handleClientConversation('client-1', client, {
      type: 'yeaft_search_history',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'req-1',
      query: 'needle',
      senderKey: 'vp:linus',
      beforeSeq: 42,
    }, allow);

    expect(getForAgent).toHaveBeenCalledWith('owner-1', 'agent-1', 'sess-1');
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'yeaft_search_history',
      sessionId: 'sess-1',
      requestId: 'req-1',
      query: 'needle',
      senderKey: 'vp:linus',
      beforeSeq: 42,
      _requestClientId: 'client-1',
    }));
  });

  it('does not fall back to currentAgent or forward an unowned Session', async () => {
    await handleClientConversation('client-1', client, {
      type: 'yeaft_search_history',
      sessionId: 'sess-1',
      query: 'needle',
    }, allow);
    expect(forwardToAgent).not.toHaveBeenCalled();

    getForAgent.mockReturnValue(null);
    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_history_window',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      anchorMessageId: 'm000001',
      anchorSeq: 1,
    }, allow);
    expect(forwardToAgent).not.toHaveBeenCalled();
  });

  it('preserves bounded anchor window fields', async () => {
    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_history_window',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'window-1',
      anchorMessageId: 'm000042',
      anchorSeq: 42,
      beforeTurns: 4,
      afterTurns: 2,
    }, allow);

    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'yeaft_load_history_window',
      requestId: 'window-1',
      anchorMessageId: 'm000042',
      anchorSeq: 42,
      beforeTurns: 4,
      afterTurns: 2,
      _requestClientId: 'client-1',
    }));
  });
});
