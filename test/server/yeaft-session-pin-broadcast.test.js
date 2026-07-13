import { afterEach, describe, expect, it, vi } from 'vitest';

const sendToWebClient = vi.fn(async () => {});
const setPinnedForAgent = vi.fn(() => true);
const webClients = new Map();

vi.mock('../../server/config.js', () => ({
  CONFIG: { skipAuth: false },
}));

vi.mock('../../server/context.js', () => ({
  agents: new Map(),
  pendingFiles: new Map(),
  trackUserTurn: vi.fn(),
  webClients,
}));

vi.mock('../../server/ws-utils.js', () => ({
  sendToWebClient,
  forwardToAgent: vi.fn(),
  broadcastAgentList: vi.fn(),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
}));

vi.mock('../../server/database.js', () => ({
  sessionDb: {},
  messageDb: {},
  userDb: {},
  yeaftSessionDb: {
    setPinnedForAgent,
  },
}));

vi.mock('../../server/handlers/session-pin-router.js', () => ({
  routeSessionPin: vi.fn(),
}));

vi.mock('../../server/perf-trace.js', () => ({
  recordPerfTraceEvent: vi.fn(),
}));

const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');

const allow = async () => true;

function client(userId) {
  return {
    authenticated: true,
    userId,
    role: 'user',
  };
}

afterEach(() => {
  sendToWebClient.mockClear();
  setPinnedForAgent.mockClear();
  webClients.clear();
});

describe('Yeaft Session pin synchronization', () => {
  it('broadcasts an agent-scoped pin update to every connected device for the same user', async () => {
    const firstDevice = client('user-1');
    const secondDevice = client('user-1');
    const foreignDevice = client('user-2');
    webClients.set('device-1', firstDevice);
    webClients.set('device-2', secondDevice);
    webClients.set('device-foreign', foreignDevice);

    await handleClientConversation('device-1', firstDevice, {
      type: 'pin_session',
      sessionKind: 'yeaft',
      agentId: 'agent-a',
      conversationId: 'session_default',
      sessionName: 'Default A',
    }, allow);

    expect(setPinnedForAgent).toHaveBeenCalledWith(
      'user-1',
      'agent-a',
      { id: 'session_default', name: 'Default A', workDir: '' },
      true,
    );
    expect(sendToWebClient).toHaveBeenCalledTimes(2);
    expect(sendToWebClient).toHaveBeenCalledWith(firstDevice, {
      type: 'session_pinned',
      conversationId: 'session_default',
      agentId: 'agent-a',
      sessionKind: 'yeaft',
      pinned: true,
    });
    expect(sendToWebClient).toHaveBeenCalledWith(secondDevice, {
      type: 'session_pinned',
      conversationId: 'session_default',
      agentId: 'agent-a',
      sessionKind: 'yeaft',
      pinned: true,
    });
    expect(sendToWebClient).not.toHaveBeenCalledWith(foreignDevice, expect.anything());
  });

  it('keeps duplicate Session ids scoped to the selected agent when unpinning', async () => {
    const firstDevice = client('user-1');
    const secondDevice = client('user-1');
    webClients.set('device-1', firstDevice);
    webClients.set('device-2', secondDevice);

    await handleClientConversation('device-2', secondDevice, {
      type: 'unpin_session',
      sessionKind: 'yeaft',
      agentId: 'agent-b',
      conversationId: 'session_default',
    }, allow);

    expect(setPinnedForAgent).toHaveBeenCalledWith(
      'user-1',
      'agent-b',
      { id: 'session_default', name: 'session_default', workDir: '' },
      false,
    );
    expect(sendToWebClient).toHaveBeenCalledTimes(2);
    for (const [, payload] of sendToWebClient.mock.calls) {
      expect(payload).toMatchObject({
        conversationId: 'session_default',
        agentId: 'agent-b',
        sessionKind: 'yeaft',
        pinned: false,
      });
    }
  });
});
