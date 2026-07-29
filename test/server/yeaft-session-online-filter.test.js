import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectSessionCatalog, yeaftCatalogKey } from '../../server/session-catalog.js';

const sendToWebClient = vi.fn(async (client, msg) => {
  client.sent.push(msg);
});
const forwardToAgent = vi.fn(async () => {});
const broadcastAgentList = vi.fn(async () => {});
const broadcastSessionCatalog = vi.fn(async () => {});
const getByUser = vi.fn(() => []);
const getByAgent = vi.fn(() => []);
const getForAgent = vi.fn(() => null);
const reconcileFromSnapshot = vi.fn();
const getChatSession = vi.fn(() => null);
const applySessionUiMetadataBatch = vi.fn(() => true);
const verifyConversationOwnership = vi.fn(() => true);
const verifyAgentOwnership = vi.fn(() => true);

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  forwardToAgent,
  broadcastAgentList,
  broadcastSessionCatalog,
  verifyConversationOwnership,
  verifyAgentOwnership,
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: {
    getActiveByUser: vi.fn(() => []),
    getByUser: vi.fn(() => []),
    get: getChatSession,
    update: vi.fn(),
    setActive: vi.fn(),
  },
  messageDb: {},
  userDb: {},
  yeaftSessionDb: {
    getByUser,
    getByAgent,
    getForAgent,
    reconcileFromSnapshot,
    setOrderForUser: vi.fn(() => true),
  },
  sessionUiMetadataDb: {
    get: vi.fn(() => null),
    getByUser: vi.fn(() => []),
    applyBatch: applySessionUiMetadataBatch,
  },
}));

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(() => false),
}));

const { CONFIG } = await import('../../server/config.js');
const { agents, webClients } = await import('../../server/context.js');
const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');
const {
  groupOnlineYeaftSessions,
  handleClientConversation,
} = await import('../../server/handlers/client-conversation.js');

const originalSkipAuth = CONFIG.skipAuth;
const allow = async () => true;

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  agents.clear();
  webClients.clear();
  getByUser.mockReset();
  getByUser.mockReturnValue([]);
  getByAgent.mockReset();
  getByAgent.mockReturnValue([]);
  reconcileFromSnapshot.mockClear();
  sendToWebClient.mockClear();
  forwardToAgent.mockClear();
  broadcastAgentList.mockClear();
  broadcastSessionCatalog.mockClear();
  getForAgent.mockReset();
  getChatSession.mockReset();
  applySessionUiMetadataBatch.mockClear();
  verifyConversationOwnership.mockReset();
  verifyConversationOwnership.mockReturnValue(true);
  verifyAgentOwnership.mockReset();
  verifyAgentOwnership.mockReturnValue(true);
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
    getChatSession.mockReturnValue({ id: 'chat-1', agent_id: 'agent-a', provider: 'copilot' });
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

    expect(applySessionUiMetadataBatch).toHaveBeenCalledWith('user-1', [
      expect.objectContaining({ catalogKey: 'yeaft:agent-a:same-id', sortRank: 0 }),
      expect.objectContaining({ catalogKey: 'yeaft:agent-b:same-id', sortRank: 1 }),
      expect.objectContaining({ catalogKey: 'chat:chat-1', sortRank: 2 }),
    ]);
    expect(broadcastSessionCatalog).toHaveBeenCalledWith('user-1');
    expect(catalogClient.sent.at(-1)).toMatchObject({
      type: 'session_catalog_reorder_result',
      ok: true,
    });

    // Offline catalog rows are authorized by their persisted composite route;
    // the online Agent registry is irrelevant to metadata durability.
    CONFIG.skipAuth = false;
    verifyAgentOwnership.mockReturnValue(false);
    verifyConversationOwnership.mockReturnValue(true);
    getForAgent.mockReturnValue({ id: 'offline-yeaft', agentId: 'agent-offline' });
    getChatSession.mockReturnValue({ id: 'offline-chat', user_id: 'user-1', agent_id: 'agent-offline', provider: 'copilot' });
    await handleClientConversation('client-1', catalogClient, {
      type: 'reorder_session_catalog',
      requestId: 'offline-order',
      sessions: [
        {
          catalogKey: 'yeaft:agent-offline:offline-yeaft',
          routeRef: { runtimeProvider: 'yeaft', agentId: 'agent-offline', sessionId: 'offline-yeaft' },
          pinned: true,
        },
        {
          catalogKey: 'chat:offline-chat',
          routeRef: { runtimeProvider: 'copilot', agentId: 'agent-offline', sessionId: 'offline-chat' },
          pinned: false,
        },
      ],
    }, allow);
    expect(applySessionUiMetadataBatch).toHaveBeenLastCalledWith('user-1', [
      expect.objectContaining({ catalogKey: 'yeaft:agent-offline:offline-yeaft', sortRank: 0 }),
      expect.objectContaining({ catalogKey: 'chat:offline-chat', sortRank: 1 }),
    ]);
    expect(catalogClient.sent.at(-1)).toMatchObject({
      type: 'session_catalog_reorder_result',
      requestId: 'offline-order',
      ok: true,
    });

    applySessionUiMetadataBatch.mockClear();
    broadcastSessionCatalog.mockClear();
    CONFIG.skipAuth = true;
    verifyAgentOwnership.mockReturnValue(true);
    await handleClientConversation('client-1', catalogClient, {
      type: 'reorder_session_catalog',
      sessions: [...sessions, { ...sessions[0], catalogKey: 'yeaft:agent-x:wrong' }],
    }, allow);
    expect(applySessionUiMetadataBatch).not.toHaveBeenCalled();
    expect(broadcastSessionCatalog).not.toHaveBeenCalled();

    CONFIG.skipAuth = false;
    agents.set('agent-a', {
      ws: { readyState: 1 },
      ownerId: 'user-1',
      conversations: new Map([['chat-1', { id: 'chat-1', title: 'Old' }]]),
    });
    const routedClient = { userId: 'user-1', role: 'user', currentAgent: 'agent-b', sent: [] };
    getChatSession.mockReturnValue({ id: 'chat-1', user_id: 'user-1', agent_id: 'agent-a', provider: 'copilot' });
    await handleClientConversation('client-1', routedClient, {
      type: 'update_conversation_settings',
      conversationId: 'chat-1',
      agentId: 'agent-a',
      title: 'Renamed',
    }, allow);
    expect(agents.get('agent-a').conversations.get('chat-1')).toMatchObject({
      title: 'Renamed',
      customTitle: true,
    });

    await handleClientConversation('client-1', routedClient, {
      type: 'delete_conversation',
      conversationId: 'chat-1',
      agentId: 'agent-a',
      requestId: 'delete-1',
    }, allow);
    expect(forwardToAgent).toHaveBeenCalledWith('agent-a', {
      type: 'delete_conversation',
      conversationId: 'chat-1',
    });
    expect(routedClient.sent.at(-1)).toMatchObject({
      type: 'conversation_delete_result',
      requestId: 'delete-1',
      agentId: 'agent-a',
      ok: true,
    });

    CONFIG.skipAuth = true;
    const ownerClient = { authenticated: true, userId: 'user-1', sent: [], ws: { readyState: 1 } };
    webClients.set('owner-client', ownerClient);
    const agent = { ownerId: 'user-1', conversations: new Map(), ws: { readyState: 1 } };
    broadcastSessionCatalog.mockClear();
    await handleAgentOutput('agent-a', agent, {
      type: 'session_crud_result', op: 'rename', ok: true, sessionId: 'same-id', requestId: 'rename-1',
    });
    expect(broadcastSessionCatalog).not.toHaveBeenCalled();
    expect(ownerClient.sent.at(-1)).toMatchObject({ type: 'session_crud_result', requestId: 'rename-1' });

    ownerClient.sent = [];
    await handleAgentOutput('agent-a', agent, {
      type: 'session_list_updated',
      sessions: [{ id: 'same-id', name: 'Renamed' }],
    });
    expect(reconcileFromSnapshot).toHaveBeenCalledWith('user-1', 'agent-a', [
      { id: 'same-id', name: 'Renamed' },
    ]);
    expect(broadcastSessionCatalog).toHaveBeenCalledTimes(1);
  });
});
