import { afterEach, describe, expect, it, vi } from 'vitest';

const sendToWebClient = vi.fn(async (client, msg) => {
  client.sent.push(msg);
});

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  broadcastAgentList: vi.fn(),
}));

const { CONFIG } = await import('../../server/config.js');
const { webClients } = await import('../../server/context.js');
const { handleAgentSync } = await import('../../server/handlers/agent-sync.js');

const originalSkipAuth = CONFIG.skipAuth;

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  webClients.clear();
  sendToWebClient.mockClear();
});

describe('agent sync LLM model discovery relay', () => {
  it('relays a partial-success config refresh warning to the owning web client', async () => {
    CONFIG.skipAuth = false;
    const client = { authenticated: true, userId: 'owner-1', sent: [] };
    webClients.set('owner-client', client);

    await expect(handleAgentSync('agent-1', { ownerId: 'owner-1' }, {
      type: 'llm_config_updated',
      providers: [{ name: 'github-copilot', credentialProvider: 'github-copilot', models: ['gpt-new'] }],
      primaryModel: 'github-copilot/gpt-new',
      statusRefreshError: 'disk read failed',
    })).resolves.toBe(true);

    expect(client.sent).toEqual([expect.objectContaining({
      type: 'llm_config_updated',
      agentId: 'agent-1',
      primaryModel: 'github-copilot/gpt-new',
      statusRefreshError: 'disk read failed',
    })]);
  });

  it('relays discovered models to the owning web client without throwing', async () => {
    CONFIG.skipAuth = false;
    webClients.set('owner-client', {
      authenticated: true,
      userId: 'owner-1',
      sent: [],
    });
    webClients.set('other-client', {
      authenticated: true,
      userId: 'other-user',
      sent: [],
    });

    await expect(handleAgentSync('agent-1', { ownerId: 'owner-1' }, {
      type: 'llm_models_discovered',
      requestId: 'req-1',
      providerType: 'github-copilot',
      provider: { name: 'github-copilot' },
      models: ['gpt-5'],
      providerModels: ['gpt-5'],
      source: 'live',
    })).resolves.toBe(true);

    expect(webClients.get('owner-client').sent).toEqual([{
      type: 'llm_models_discovered',
      agentId: 'agent-1',
      requestId: 'req-1',
      providerType: 'github-copilot',
      provider: { name: 'github-copilot' },
      models: ['gpt-5'],
      providerModels: ['gpt-5'],
      source: 'live',
    }]);
    expect(webClients.get('other-client').sent).toEqual([]);
  });
});
