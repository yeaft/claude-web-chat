import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectSessionCatalog, yeaftCatalogKey } from '../../server/session-catalog.js';

const sendToWebClient = vi.fn(async (client, msg) => {
  client.sent.push(msg);
});
const broadcastAgentList = vi.fn(async () => {});
const broadcastSessionCatalog = vi.fn(async () => {});
const getByUser = vi.fn(() => []);
const getForAgent = vi.fn(() => null);
const getChatSession = vi.fn(() => null);
const upsertSessionUiMetadata = vi.fn(() => true);

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  forwardToAgent: vi.fn(),
  broadcastAgentList,
  broadcastSessionCatalog,
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: {
    getActiveByUser: vi.fn(() => []),
    getByUser: vi.fn(() => []),
    get: getChatSession,
    setActive: vi.fn(),
  },
  messageDb: {},
  userDb: {},
  yeaftSessionDb: {
    getByUser,
    getForAgent,
    setOrderForUser: vi.fn(() => true),
  },
  sessionUiMetadataDb: {
    getByUser: vi.fn(() => []),
    upsert: upsertSessionUiMetadata,
  },
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
  broadcastSessionCatalog.mockClear();
  getForAgent.mockReset();
  getChatSession.mockReset();
  upsertSessionUiMetadata.mockClear();
});

describe('Yeaft Session online Agent filtering', () => {
  const verifyCatalogProjection = () => {
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

    const catalog = projectSessionCatalog({
      chatSessions: [
        { id: 'same-id', agent_id: 'chat-agent', title: 'Chat', updated_at: 10, is_active: 1 },
        { id: 'inactive', agent_id: 'chat-agent', is_active: 0 },
      ],
      yeaftSessions: [
        { id: 'same-id', agentId: 'agent-online', name: 'Online', updatedAt: 20 },
        { id: 'same-id', agentId: 'agent-closed', name: 'Closed', updatedAt: 30 },
      ],
      metadata: [{ catalogKey: yeaftCatalogKey('agent-online', 'same-id'), pinned: true, sortRank: 1 }],
      onlineAgentIds: new Set(['agent-online']),
    });
    expect(catalog.map(row => row.catalogKey)).toEqual([
      'yeaft:agent-online:same-id',
      'yeaft:agent-closed:same-id',
      'chat:same-id',
    ]);
    expect(catalog.map(row => row.availability)).toEqual(['online', 'offline', 'offline']);
    expect(catalog.some(row => row.catalogKey === 'chat:inactive')).toBe(false);
    expect(() => projectSessionCatalog({
      chatSessions: [{ id: 'bad', agent_id: 'a', provider: 'mystery', is_active: 1 }],
    })).toThrow(/Unknown Chat runtime provider/);
  };

  it('projects canonical availability and handles catalog lifecycle updates', async () => {
    verifyCatalogProjection();
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

    expect(broadcastAgentList).toHaveBeenCalledOnce();
    expect(client.sent).toEqual([{
      type: 'yeaft_session_hydrate',
      agentId: 'agent-online',
      sessions: [
        { id: 'online-pinned', agentId: 'agent-online', pinned: true },
        { id: 'online-free', agentId: 'agent-online', pinned: false },
      ],
      fromDb: true,
    }]);

    await handleClientConversation('client-1', client, {
      type: 'reorder_yeaft_sessions',
      sessions: [{ agentId: 'agent-online', sessionId: 'online-free' }],
      requestId: 'reorder-1',
    }, allow);
    expect(broadcastSessionCatalog).toHaveBeenCalledWith('user-1');
    expect(client.sent.at(-1)).toMatchObject({
      type: 'session_crud_result',
      op: 'reorder',
      requestId: 'reorder-1',
      ok: true,
    });

    // Unified ordering validates the complete canonical identity batch before
    // committing any metadata writes.
    CONFIG.skipAuth = true;
    getForAgent.mockImplementation((_userId, agentId, sessionId) => (
      sessionId === 'same-id' ? { id: sessionId, agentId } : null
    ));
    getChatSession.mockReturnValue({ id: 'chat-1', provider: 'copilot' });
    const catalogClient = { userId: 'user-1', role: 'user', sent: [] };
    const sessions = [
      {
        catalogKey: 'yeaft:agent-a:same-id',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'same-id' },
        pinned: true,
      },
      {
        catalogKey: 'yeaft:agent-b:same-id',
        routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-b', sessionId: 'same-id' },
        pinned: false,
      },
      {
        catalogKey: 'chat:chat-1',
        routeRef: { runtimeProvider: 'copilot', agentId: 'agent-a', sessionId: 'chat-1' },
        pinned: false,
      },
    ];

    await handleClientConversation('client-1', catalogClient, {
      type: 'reorder_session_catalog',
      sessions,
    }, allow);

    expect(upsertSessionUiMetadata.mock.calls.map(call => call.slice(0, 3))).toEqual([
      ['user-1', 'yeaft:agent-a:same-id', expect.objectContaining({ sortRank: 0 })],
      ['user-1', 'yeaft:agent-b:same-id', expect.objectContaining({ sortRank: 1 })],
      ['user-1', 'chat:chat-1', expect.objectContaining({ sortRank: 2 })],
    ]);
    expect(broadcastSessionCatalog).toHaveBeenCalledWith('user-1');

    upsertSessionUiMetadata.mockClear();
    broadcastSessionCatalog.mockClear();
    await handleClientConversation('client-1', catalogClient, {
      type: 'reorder_session_catalog',
      sessions: [...sessions, { ...sessions[0], catalogKey: 'yeaft:agent-x:wrong' }],
    }, allow);
    expect(upsertSessionUiMetadata).not.toHaveBeenCalled();
    expect(broadcastSessionCatalog).not.toHaveBeenCalled();
  });
});
