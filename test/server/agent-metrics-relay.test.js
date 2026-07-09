import { afterEach, describe, expect, it, vi } from 'vitest';

const sendToWebClient = vi.fn(async (client, msg) => {
  client.sent.push(msg);
});
const broadcastAgentList = vi.fn();

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  broadcastAgentList,
}));

const { CONFIG } = await import('../../server/config.js');
const { webClients } = await import('../../server/context.js');
const { handleAgentSync } = await import('../../server/handlers/agent-sync.js');

const originalSkipAuth = CONFIG.skipAuth;

afterEach(() => {
  CONFIG.skipAuth = originalSkipAuth;
  webClients.clear();
  sendToWebClient.mockClear();
  broadcastAgentList.mockClear();
});

describe('agent metrics relay', () => {
  it('stores metrics and sends a lightweight metrics event without broadcasting agent_list', async () => {
    CONFIG.skipAuth = false;
    webClients.set('owner-client', {
      authenticated: true,
      userId: 'owner-1',
      role: 'pro',
      sent: [],
    });
    webClients.set('other-client', {
      authenticated: true,
      userId: 'other-user',
      role: 'pro',
      sent: [],
    });

    const agent = { ownerId: 'owner-1' };
    await handleAgentSync('agent-1', agent, {
      type: 'agent_metrics',
      metrics: {
        chatTurns: 1,
        yeaftTurns: 2,
        inputTokens: 10,
        outputTokens: 5,
      },
    });

    expect(agent.metrics).toMatchObject({
      chatTurns: 1,
      yeaftTurns: 2,
      totalTurns: 3,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    expect(agent.metricsUpdatedAt).toEqual(expect.any(Number));
    expect(broadcastAgentList).not.toHaveBeenCalled();
    expect(webClients.get('owner-client').sent).toEqual([{
      type: 'agent_metrics',
      agentId: 'agent-1',
      metrics: expect.objectContaining({ totalTurns: 3, totalTokens: 15 }),
      metricsUpdatedAt: expect.any(Number),
    }]);
    expect(webClients.get('other-client').sent).toEqual([]);
  });
});
