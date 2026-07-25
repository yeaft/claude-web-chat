import { afterEach, describe, expect, it, vi } from 'vitest';

const sendToWebClient = vi.fn(async (client, msg) => {
  client.sent.push(msg);
});
const broadcastAgentList = vi.fn(async () => {});
const forwardToAgent = vi.fn(async () => {});
const forwardToClients = vi.fn(async () => {});
const messageAdd = vi.fn(() => 1);
const getByUser = vi.fn(() => []);

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  forwardToAgent,
  forwardToClients,
  broadcastAgentList,
  sendToAgent: vi.fn(),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: {
    getActiveByUser: vi.fn(() => []),
    get: vi.fn(() => null),
    setActive: vi.fn(),
    update: vi.fn(),
  },
  messageDb: { add: messageAdd },
  userDb: {},
  yeaftSessionDb: { getByUser },
}));

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(() => false),
}));

const { CONFIG } = await import('../../server/config.js');
const { agents } = await import('../../server/context.js');
const {
  groupOnlineYeaftSessions,
  handleClientConversation,
} = await import('../../server/handlers/client-conversation.js');
const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');

const originalSkipAuth = CONFIG.skipAuth;
const allow = async () => true;

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  agents.clear();
  getByUser.mockReset();
  getByUser.mockReturnValue([]);
  sendToWebClient.mockClear();
  forwardToAgent.mockClear();
  forwardToClients.mockClear();
  messageAdd.mockClear();
  broadcastAgentList.mockClear();
});

describe('Yeaft Session online Agent filtering', () => {
  it('groups only sessions whose Agent socket is open', () => {
    const registry = new Map([
      ['agent-online', { ws: { readyState: 1 } }],
      ['agent-closed', { ws: { readyState: 3 } }],
    ]);

    expect(groupOnlineYeaftSessions([
      { id: 'online-pinned', agentId: 'agent-online', pinned: true },
      { id: 'online-free', agentId: 'agent-online', pinned: false },
      { id: 'closed-pinned', agentId: 'agent-closed', pinned: true },
      { id: 'missing-free', agentId: 'agent-missing', pinned: false },
    ], registry)).toEqual({
      'agent-online': [
        { id: 'online-pinned', agentId: 'agent-online', pinned: true },
        { id: 'online-free', agentId: 'agent-online', pinned: false },
      ],
    });
  });

  it('round-trips each native-provider client message identity to the Agent', async () => {
    CONFIG.skipAuth = true;
    const conversation = { id: 'chat-1', provider: 'copilot', processing: false };
    agents.set('agent-1', {
      ws: { readyState: 1 },
      status: 'ready',
      conversations: new Map([['chat-1', conversation]]),
    });
    const client = { userId: 'user-1', currentAgent: 'agent-1', sent: [] };

    await handleClientConversation('client-1', client, {
      type: 'chat',
      conversationId: 'chat-1',
      prompt: 'same',
      clientMessageId: 'cm_first',
    }, allow);
    await handleClientConversation('client-1', client, {
      type: 'chat',
      conversationId: 'chat-1',
      prompt: 'same',
      clientMessageId: 'cm_second',
    }, allow);

    expect(forwardToAgent.mock.calls.map(([, payload]) => payload.clientMessageId))
      .toEqual(['cm_first', 'cm_second']);
    expect(conversation._pendingClientMessageId).toBeUndefined();

    const agent = agents.get('agent-1');
    await handleAgentOutput('agent-1', agent, {
      type: 'claude_output',
      conversationId: 'chat-1',
      data: { type: 'user', message: { content: 'same' }, clientMessageId: 'cm_first' },
    });
    await handleAgentOutput('agent-1', agent, {
      type: 'claude_output',
      conversationId: 'chat-1',
      data: { type: 'user', message: { content: 'same' }, clientMessageId: 'cm_second' },
    });
    expect(messageAdd.mock.calls.map(call => JSON.parse(call[6]).clientMessageId))
      .toEqual(['cm_first', 'cm_second']);
    expect(forwardToClients.mock.calls.map(([, , payload]) => payload.data.clientMessageId))
      .toEqual(['cm_first', 'cm_second']);
    await verifyHydratesPinnedSessions();
  });

  async function verifyHydratesPinnedSessions() {
    CONFIG.skipAuth = false;
    agents.set('agent-online', {
      ws: { readyState: 1 },
      ownerId: 'user-1',
      conversations: new Map(),
    });
    agents.set('agent-closed', {
      ws: { readyState: 3 },
      ownerId: 'user-1',
      conversations: new Map(),
    });
    getByUser.mockReturnValue([
      { id: 'online-pinned', agentId: 'agent-online', pinned: true },
      { id: 'online-free', agentId: 'agent-online', pinned: false },
      { id: 'closed-pinned', agentId: 'agent-closed', pinned: true },
      { id: 'missing-free', agentId: 'agent-missing', pinned: false },
    ]);
    const client = {
      userId: 'user-1',
      username: 'user',
      sent: [],
    };

    await handleClientConversation('client-1', client, { type: 'get_agents' }, allow);

    expect(client.sent).toEqual([{
      type: 'yeaft_session_hydrate',
      agentId: 'agent-online',
      sessions: [
        { id: 'online-pinned', agentId: 'agent-online', pinned: true },
        { id: 'online-free', agentId: 'agent-online', pinned: false },
      ],
      fromDb: true,
    }]);
  }
});
