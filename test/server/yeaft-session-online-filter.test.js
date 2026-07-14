import { afterEach, describe, expect, it, vi } from 'vitest';

const sendToWebClient = vi.fn(async (client, msg) => {
  client.sent.push(msg);
});
const broadcastAgentList = vi.fn(async () => {});
const getByUser = vi.fn(() => []);

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  forwardToAgent: vi.fn(),
  broadcastAgentList,
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: {
    getActiveByUser: vi.fn(() => []),
    get: vi.fn(() => null),
    setActive: vi.fn(),
  },
  messageDb: {},
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

const originalSkipAuth = CONFIG.skipAuth;
const allow = async () => true;

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  agents.clear();
  getByUser.mockReset();
  getByUser.mockReturnValue([]);
  sendToWebClient.mockClear();
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

  it('hydrates pinned and unpinned sessions only for connected Agents', async () => {
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
  });
});
