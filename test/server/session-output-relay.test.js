import { afterEach, describe, expect, it, vi } from 'vitest';

const sendToWebClient = vi.fn(async (client, msg) => {
  client.sent.push(msg);
});

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  sendToAgent: vi.fn(async (agent, msg) => { (agent.sent ||= []).push(msg); }),
  broadcastAgentList: vi.fn(),
  forwardToClients: vi.fn(async (_agentId, _conversationId, msg) => {
    for (const [, client] of webClients) {
      if (client.authenticated) await sendToWebClient(client, msg);
    }
  }),
}));

vi.mock('../../server/database.js', () => ({
  messageDb: {},
  yeaftSessionDb: {
    reconcileFromSnapshot: vi.fn(),
    getByAgent: vi.fn(() => []),
    upsertFromSnapshot: vi.fn(),
    deleteForAgent: vi.fn(),
    setArchivedForAgent: vi.fn(),
  },
}));

const { CONFIG } = await import('../../server/config.js');
const { webClients } = await import('../../server/context.js');
const { yeaftSessionDb } = await import('../../server/database.js');
const { yeaftAssetStore } = await import('../../server/yeaft-asset-store.js');
const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');

const originalSkipAuth = CONFIG.skipAuth;

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
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

  it('stamps agentId on per-conversation slash command updates', async () => {
    CONFIG.skipAuth = false;
    webClients.set('owner-client', {
      authenticated: true,
      userId: 'owner-1',
      sent: [],
    });
    const agent = { ownerId: 'owner-1', slashCommandDescriptions: {} };

    await handleAgentOutput('agent-1', agent, {
      type: 'slash_commands_update',
      conversationId: 'yeaft-1',
      slashCommands: ['yeaft-skills:code-review'],
      slashCommandDescriptions: { 'yeaft-skills:code-review': 'Code review' },
    });

    expect(agent.slashCommands).toEqual(['yeaft-skills:code-review']);
    expect(webClients.get('owner-client').sent).toEqual([{
      type: 'slash_commands_update',
      agentId: 'agent-1',
      conversationId: 'yeaft-1',
      slashCommands: ['yeaft-skills:code-review'],
      slashCommandDescriptions: { 'yeaft-skills:code-review': 'Code review' },
    }]);
  });
});
