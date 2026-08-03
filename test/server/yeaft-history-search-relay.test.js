import { afterEach, describe, expect, it, vi } from 'vitest';

const forwardToAgent = vi.fn(async () => {});
const sendToWebClient = vi.fn(async (target, msg) => { target.sent ??= []; target.sent.push(msg); });
const getForAgent = vi.fn(() => ({ id: 'sess-1', agentId: 'agent-1', userId: 'owner-1' }));
const contextForSession = vi.fn(() => null);

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  forwardToAgent,
  broadcastAgentList: vi.fn(),
  buildSessionCatalog: vi.fn(() => []),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: { get: vi.fn(() => null) },
  messageDb: {},
  userDb: {},
  yeaftProjectDb: {
    contextForSession,
    list: vi.fn(() => []),
    create: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    moveSession: vi.fn(),
  },
  yeaftSessionDb: { getByUser: vi.fn(() => []), getForAgent },
  sessionUiMetadataDb: {},
}));

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(() => false),
}));

const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');
const allow = async () => true;
const client = { userId: 'owner-1', username: 'u', currentAgent: 'wrong-agent', sent: [] };

afterEach(() => {
  forwardToAgent.mockClear();
  getForAgent.mockClear();
  getForAgent.mockReturnValue({ id: 'sess-1', agentId: 'agent-1', userId: 'owner-1' });
  contextForSession.mockReset();
  contextForSession.mockReturnValue(null);
  sendToWebClient.mockClear();
  client.sent = [];
});

describe('Yeaft Session history search relay', () => {


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

    forwardToAgent.mockClear();
    await handleClientConversation('client-1', client, {
      type: 'yeaft_load_history',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      requestId: 'history-1',
      limit: 5,
    }, allow);
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'yeaft_load_history',
      sessionId: 'sess-1',
      requestId: 'history-1',
      _requestClientId: 'client-1',
    }));

    contextForSession.mockReturnValue({
      projectId: 'project-1',
      projectName: 'Project 1',
      projectInstruction: 'Use the shared Project checks.',
      sessionIds: ['sess-2'],
    });
    forwardToAgent.mockClear();
    await handleClientConversation('client-1', client, {
      type: 'yeaft_session_send',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      text: 'share only this Agent',
    }, allow);
    expect(contextForSession).toHaveBeenCalledWith('owner-1', 'agent-1', 'sess-1');
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'yeaft_session_send',
      sessionId: 'sess-1',
      projectContext: {
        projectId: 'project-1',
        projectName: 'Project 1',
        projectInstruction: 'Use the shared Project checks.',
        sessionIds: ['sess-2'],
      },
    }));

    contextForSession.mockReturnValue(null);
    forwardToAgent.mockClear();
    await handleClientConversation('client-1', client, {
      type: 'yeaft_session_send',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      text: 'no project',
    }, allow);
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      projectContext: {
        projectId: null,
        projectName: null,
        projectInstruction: '',
        sessionIds: [],
      },
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


});
