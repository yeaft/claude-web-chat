import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sendToWebClient = vi.fn(async (client, msg) => {
  client.sent.push(msg);
});

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  sendToAgent: vi.fn(async (agent, msg) => { (agent.sent ||= []).push(msg); }),
  forwardToAgent: vi.fn(),
  broadcastAgentList: vi.fn(),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
  forwardToClients: vi.fn(async (_agentId, _conversationId, msg) => {
    for (const [, client] of webClients) {
      if (client.authenticated) await sendToWebClient(client, msg);
    }
  }),
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: { get: vi.fn(() => null) },
  messageDb: {},
  userDb: {},
  yeaftSessionDb: {
    reconcileFromSnapshot: vi.fn(),
    getByAgent: vi.fn(() => []),
    upsertFromSnapshot: vi.fn(),
    deleteForAgent: vi.fn(),
    setArchivedForAgent: vi.fn(),
  },
}));

const { CONFIG } = await import('../../server/config.js');
const { agents, webClients } = await import('../../server/context.js');
const { yeaftSessionDb } = await import('../../server/database.js');
const { yeaftAssetStore } = await import('../../server/yeaft-asset-store.js');
const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');
const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');
const { ConversationStore } = await import('../../agent/yeaft/conversation/persist.js');
const { __testHooks: webBridgeTestHooks } = await import('../../agent/yeaft/web-bridge.js');

const originalSkipAuth = CONFIG.skipAuth;

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  agents.clear();
  webClients.clear();
  sendToWebClient.mockClear();
  vi.restoreAllMocks();
});

describe('Yeaft Session output relay aliases', () => {
  it('accepts neutral agent aliases and relays legacy yeaft_output for old web compatibility', async () => {
    CONFIG.skipAuth = false;
    webClients.set('owner-client', {
      authenticated: true,
      userId: 'owner-1',
      sent: [],
    });

    const data = { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } };
    await expect(handleAgentOutput('agent-1', { ownerId: 'owner-1' }, {
      type: 'session_output',
      conversationId: 'yeaft-1',
      sessionId: 'sess-1',
      vpId: 'vp-1',
      data,
    })).resolves.toBe(true);

    expect(webClients.get('owner-client').sent).toEqual([{
      type: 'yeaft_output',
      conversationId: 'yeaft-1',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      vpId: 'vp-1',
      data,
      event: undefined,
    }]);
  });

  it('persists nested Session archive results so removed rows stay out of DB hydration', async () => {
    CONFIG.skipAuth = false;
    webClients.set('owner-client', { authenticated: true, userId: 'owner-1', sent: [] });

    await handleAgentOutput('agent-1', { ownerId: 'owner-1' }, {
      type: 'yeaft_output',
      conversationId: 'yeaft-1',
      event: {
        type: 'session_crud_result',
        op: 'archive',
        ok: true,
        requestId: 'archive-1',
        sessionId: 'sess-1',
      },
    });

    expect(yeaftSessionDb.setArchivedForAgent).toHaveBeenCalledWith('owner-1', 'agent-1', 'sess-1', true);
    expect(webClients.get('owner-client').sent).toEqual([expect.objectContaining({
      type: 'yeaft_output',
      agentId: 'agent-1',
      event: expect.objectContaining({ type: 'session_crud_result', op: 'archive', sessionId: 'sess-1' }),
    })]);
  });

  it('reconciles and decorates nested Session snapshots before relaying them', async () => {
    CONFIG.skipAuth = false;
    webClients.set('owner-client', { authenticated: true, userId: 'owner-1', sent: [] });
    yeaftSessionDb.getByAgent.mockReturnValueOnce([{ id: 'sess-1', isPinned: true, sortOrder: 3 }]);
    const sessions = [{ id: 'sess-1', name: 'Session 1' }];

    await handleAgentOutput('agent-1', { ownerId: 'owner-1' }, {
      type: 'yeaft_output',
      conversationId: 'yeaft-1',
      event: { type: 'session_list_updated', sessions },
    });

    expect(yeaftSessionDb.reconcileFromSnapshot).toHaveBeenCalledWith('owner-1', 'agent-1', sessions);
    expect(webClients.get('owner-client').sent[0].event.sessions).toEqual([
      expect.objectContaining({ id: 'sess-1', pinned: true, isPinned: true, sortOrder: 3 }),
    ]);
  });

  it('stores a Session image and relays only stable asset metadata', async () => {
    CONFIG.skipAuth = false;
    webClients.set('owner-client', { authenticated: true, userId: 'owner-1', sent: [] });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const agent = { ownerId: 'owner-1', sent: [] };
    await expect(handleAgentOutput('agent-1', agent, {
      type: 'yeaft_asset_put',
      deliveryId: 'delivery-1234567890',
      conversationId: 'yeaft-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      image: {
        mimeType: 'image/png',
        filename: 'pixel.png',
        previewData: { data: png, mimeType: 'image/png' },
      },
    })).resolves.toBe(true);

    const [message] = webClients.get('owner-client').sent;
    expect(message).toMatchObject({
      type: 'yeaft_asset_ready',
      agentId: 'agent-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      image: { mimeType: 'image/png', filename: 'pixel.png' },
    });
    expect(message.image.src).toMatch(/^\/api\/yeaft\/assets\//);
    expect(message.image).not.toHaveProperty('previewData');
    expect(JSON.stringify(message)).not.toContain(png);
    expect(agent.sent).toEqual([{ type: 'yeaft_asset_ack', deliveryId: 'delivery-1234567890', ok: true }]);
  });

  it('hides permanently rejected pending metadata and restores it after an idempotent replay succeeds', async () => {
    CONFIG.skipAuth = false;
    const client = { authenticated: true, userId: 'owner-1', sent: [] };
    webClients.set('owner-client', client);
    const agent = { ownerId: 'owner-1', sent: [] };
    const sessionId = 'sess-permanent-reject-replay';
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const pendingImage = { assetId: 'pending', mimeType: 'image/png', filename: 'pixel.png' };
    yeaftAssetStore.deleteScope({ ownerId: 'owner-1', agentId: 'agent-1', sessionId });
    const quotaFailure = vi.spyOn(yeaftAssetStore, 'put').mockImplementationOnce(() => {
      throw new Error('Session image asset quota exceeded');
    });

    await handleAgentOutput('agent-1', agent, {
      type: 'yeaft_asset_put', deliveryId: 'delivery-permanent-1', conversationId: 'yeaft-1',
      sessionId, turnId: 'turn-1',
      image: { mimeType: 'image/png', filename: 'pixel.png', previewData: { data: png, mimeType: 'image/png' } },
    });
    expect(agent.sent).toEqual([expect.objectContaining({
      type: 'yeaft_asset_ack', deliveryId: 'delivery-permanent-1', ok: false, permanent: true,
    })]);

    const batchLookup = vi.spyOn(yeaftAssetStore, 'describeTurns');
    const toolPage = [
      { id: 'm0', role: 'user', turnId: 'turn-1', content: 'prompt' },
      {
        id: 'm1', role: 'assistant', turnId: 'turn-1', content: '',
        toolCalls: [{ id: 'call-1', name: 'ImageGeneration', input: {} }],
        images: [pendingImage],
      },
      { id: 'm2', role: 'tool', turnId: 'turn-1', toolCallId: 'call-1', content: '{"success":true}' },
    ];
    const historyDir = mkdtempSync(join(tmpdir(), 'yeaft-asset-history-wire-'));
    const historyStore = new ConversationStore(historyDir);
    historyStore.append({
      role: 'assistant', sessionId, turnId: 'turn-1', content: 'Here is the image.',
      imageAssetAnchor: true,
    });
    const persistedFinalPage = historyStore.loadAllBySession(sessionId);
    const projectedToolPage = webBridgeTestHooks.projectVisibleHistoryChunkMessages(toolPage);
    const projectedFinalPage = webBridgeTestHooks.projectVisibleHistoryChunkMessages(persistedFinalPage);
    expect(projectedToolPage.every(message => message.imageAssetAnchor !== true)).toBe(true);
    expect(projectedFinalPage).toEqual([
      expect.objectContaining({ turnId: 'turn-1', imageAssetAnchor: true }),
    ]);

    await handleAgentOutput('agent-1', agent, {
      type: 'yeaft_history_window', _requestClientId: 'owner-client', requestId: 'window-1',
      sessionId, messages: [...projectedToolPage, ...projectedFinalPage],
    });
    expect(batchLookup).toHaveBeenCalledTimes(1);
    expect(batchLookup).toHaveBeenCalledWith({
      ownerId: 'owner-1', agentId: 'agent-1', sessionId, turnIds: ['turn-1'],
    });
    expect(client.sent.at(-1).messages.every(message => !message.images)).toBe(true);

    quotaFailure.mockRestore();
    await handleAgentOutput('agent-1', agent, {
      type: 'yeaft_asset_put', deliveryId: 'delivery-replay-123', conversationId: 'yeaft-1',
      sessionId, turnId: 'turn-1',
      image: { mimeType: 'image/png', filename: 'pixel.png', previewData: { data: png, mimeType: 'image/png' } },
    });

    client.sent.length = 0;
    batchLookup.mockClear();
    await handleAgentOutput('agent-1', agent, {
      type: 'yeaft_history_window', _requestClientId: 'owner-client', requestId: 'window-2',
      sessionId, messages: projectedToolPage,
    });
    expect(batchLookup).toHaveBeenCalledTimes(1);
    expect(batchLookup).toHaveBeenCalledWith({
      ownerId: 'owner-1', agentId: 'agent-1', sessionId, turnIds: [],
    });
    expect(client.sent[0].messages.every(message => !message.images)).toBe(true);

    client.sent.length = 0;
    batchLookup.mockClear();
    await handleAgentOutput('agent-1', agent, {
      type: 'yeaft_history_chunk', conversationId: 'yeaft-1', sessionId,
      messages: projectedFinalPage, mode: 'older',
    });
    expect(batchLookup).toHaveBeenCalledTimes(1);
    expect(batchLookup).toHaveBeenCalledWith({
      ownerId: 'owner-1', agentId: 'agent-1', sessionId, turnIds: ['turn-1'],
    });
    expect(client.sent[0]).toMatchObject({
      type: 'yeaft_history_chunk',
      agentId: 'agent-1',
      conversationId: 'yeaft-1',
      sessionId,
    });
    expect(client.sent[0].messages).toHaveLength(1);
    expect(client.sent[0].messages[0].images).toEqual([
      expect.objectContaining({ mimeType: 'image/png', src: expect.stringMatching(/^\/api\/yeaft\/assets\//) }),
    ]);
    yeaftAssetStore.deleteScope({ ownerId: 'owner-1', agentId: 'agent-1', sessionId });
    rmSync(historyDir, { recursive: true, force: true });
  });

  it('cleans only the deleted Session asset scope after agent-confirmed deletion', async () => {
    CONFIG.skipAuth = false;
    webClients.set('owner-client', { authenticated: true, userId: 'owner-1', sent: [] });
    const cleanup = vi.spyOn(yeaftAssetStore, 'deleteScope').mockReturnValue(1);

    await handleAgentOutput('agent-1', { ownerId: 'owner-1' }, {
      type: 'session_crud_result', op: 'delete', ok: true, sessionId: 'sess-1', alreadyGone: true,
    });

    expect(yeaftSessionDb.deleteForAgent).toHaveBeenCalledWith('owner-1', 'agent-1', 'sess-1');
    expect(cleanup).toHaveBeenCalledWith({ ownerId: 'owner-1', agentId: 'agent-1', sessionId: 'sess-1' });
  });

  it('does not clean image assets when a Session delete fails or is only archived', async () => {
    const cleanup = vi.spyOn(yeaftAssetStore, 'deleteScope').mockReturnValue(0);
    await handleAgentOutput('agent-1', { ownerId: 'owner-1' }, {
      type: 'session_crud_result', op: 'delete', ok: false, sessionId: 'sess-1',
    });
    await handleAgentOutput('agent-1', { ownerId: 'owner-1' }, {
      type: 'session_crud_result', op: 'archive', ok: true, sessionId: 'sess-1',
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('preserves authoritative Yeaft preload snapshots without overwriting the Claude cache', async () => {
    CONFIG.skipAuth = false;
    webClients.set('owner-client', {
      authenticated: true,
      userId: 'owner-1',
      sent: [],
    });
    const agent = { ownerId: 'owner-1', slashCommandDescriptions: {} };

    await handleAgentOutput('agent-1', agent, {
      type: 'slash_commands_update',
      conversationId: '__preload__',
      slashCommands: ['/compact'],
      slashCommandDescriptions: { '/compact': 'Compact context' },
    });
    await handleAgentOutput('agent-1', agent, {
      type: 'slash_commands_update',
      commandSet: 'yeaft',
      conversationId: '__preload__',
      slashCommands: ['project-review'],
      slashCommandDescriptions: { 'project-review': 'Review this project' },
    });
    await handleAgentOutput('agent-1', agent, {
      type: 'slash_commands_update',
      commandSet: 'yeaft',
      conversationId: '__preload__',
      slashCommands: [],
      slashCommandDescriptions: {},
    });

    expect(agent.slashCommands).toEqual(['/compact']);
    expect(agent.slashCommandDescriptions).toEqual({ '/compact': 'Compact context' });
    expect(agent.yeaftSlashCommands).toEqual([]);
    expect(agent.yeaftSlashCommandDescriptions).toEqual({});

    const client = webClients.get('owner-client');
    const [claudeUpdate, yeaftUpdate, emptyYeaftUpdate] = client.sent;
    expect(claudeUpdate).toEqual({
      type: 'slash_commands_update',
      agentId: 'agent-1',
      slashCommands: ['/compact'],
      slashCommandDescriptions: { '/compact': 'Compact context' },
    });
    expect(claudeUpdate).not.toHaveProperty('commandSet');
    expect(yeaftUpdate).toEqual({
      type: 'slash_commands_update',
      agentId: 'agent-1',
      commandSet: 'yeaft',
      slashCommands: ['project-review'],
      slashCommandDescriptions: { 'project-review': 'Review this project' },
    });
    expect(emptyYeaftUpdate).toEqual({
      type: 'slash_commands_update',
      agentId: 'agent-1',
      commandSet: 'yeaft',
      slashCommands: [],
      slashCommandDescriptions: {},
    });

    agents.set('agent-1', {
      ...agent,
      ws: { readyState: 1 },
      name: 'Agent 1',
      workDir: '/work',
      conversations: new Map(),
    });
    await handleClientConversation('owner-client', client, {
      type: 'select_agent',
      agentId: 'agent-1',
    }, async () => true);
    expect(client.sent.at(-1)).toMatchObject({
      type: 'agent_selected',
      slashCommands: ['/compact'],
      slashCommandDescriptions: { '/compact': 'Compact context' },
    });
  });

  it('preserves commandSet on per-conversation Yeaft slash command updates', async () => {
    CONFIG.skipAuth = false;
    webClients.set('owner-client', {
      authenticated: true,
      userId: 'owner-1',
      sent: [],
    });
    const agent = { ownerId: 'owner-1', slashCommandDescriptions: {} };

    await handleAgentOutput('agent-1', agent, {
      type: 'slash_commands_update',
      commandSet: 'yeaft',
      conversationId: 'yeaft-1',
      slashCommands: ['code-review'],
      slashCommandDescriptions: { 'code-review': 'Code review' },
    });

    expect(webClients.get('owner-client').sent).toEqual([{
      type: 'slash_commands_update',
      agentId: 'agent-1',
      conversationId: 'yeaft-1',
      commandSet: 'yeaft',
      slashCommands: ['code-review'],
      slashCommandDescriptions: { 'code-review': 'Code review' },
    }]);
  });
});
