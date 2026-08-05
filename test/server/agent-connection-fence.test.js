import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWebSocket, WS_CLOSED, WS_OPEN } from '../helpers/mockWs.js';

const broadcastAgentList = vi.fn(async () => {});
const clearAgentDirCache = vi.fn();
const getOrCreateUser = vi.fn(() => ({ id: 'local-user-id', username: 'dev-user' }));

vi.mock('../../server/config.js', () => ({
  CONFIG: {
    skipAuth: true,
    debug: false,
  },
}));

const verifyAgent = vi.fn(() => ({
  valid: true,
  sessionKey: null,
  userId: 'owner-1',
  username: 'owner',
}));
vi.mock('../../server/auth.js', () => ({ verifyAgent }));

vi.mock('../../server/ws-utils.js', () => ({
  parseMessage: vi.fn(async (data) => JSON.parse(data.toString())),
  broadcastAgentList,
  clearAgentDirCache,
}));

vi.mock('../../server/handlers/agent-conversation.js', () => ({
  handleAgentConversation: vi.fn(async () => false),
}));
vi.mock('../../server/handlers/agent-work-center.js', () => ({
  handleAgentWorkCenter: vi.fn(async () => false),
}));
vi.mock('../../server/handlers/agent-file-terminal.js', () => ({
  handleAgentFileTerminal: vi.fn(async () => false),
}));
vi.mock('../../server/handlers/agent-sync.js', () => ({
  handleAgentSync: vi.fn(async () => false),
}));
vi.mock('../../server/perf-trace.js', () => ({ recordPerfTraceEvent: vi.fn() }));
vi.mock('../../server/database.js', () => ({ userDb: { getOrCreate: getOrCreateUser } }));

const handleAgentOutput = vi.fn(async () => true);
vi.mock('../../server/handlers/agent-output.js', () => ({ handleAgentOutput }));

const { CONFIG } = await import('../../server/config.js');
const { agents, pendingAgentConnections } = await import('../../server/context.js');
const { handleAgentConnection } = await import('../../server/ws-agent.js');

function agentUrl(id = 'agent-1') {
  return new URL(`ws://localhost/?type=agent&id=${id}&name=Agent&instanceId=${id}&capabilities=plaintext-ok`);
}

function authenticate(socket) {
  const challenge = socket.getLastMessage();
  socket.simulateMessage({
    type: 'auth',
    tempId: challenge.tempId,
    secret: 'owner-secret',
    capabilities: ['plaintext-ok'],
    version: '1.0.0',
  });
}

async function settleMessages() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  CONFIG.skipAuth = true;
  agents.clear();
  pendingAgentConnections.clear();
  broadcastAgentList.mockClear();
  clearAgentDirCache.mockClear();
  handleAgentOutput.mockClear();
  verifyAgent.mockClear();
  getOrCreateUser.mockClear();
  delete process.env.YEAFT_LOCAL_RUN;
});

afterEach(() => {
  for (const agent of agents.values()) {
    if (agent._syncTimeout) clearTimeout(agent._syncTimeout);
  }
  agents.clear();
  pendingAgentConnections.clear();
  vi.useRealTimers();
});

describe('Agent connection replacement fence', () => {
  it('retires the old socket and ignores its messages after a replacement registers', async () => {
    const oldSocket = new MockWebSocket(WS_OPEN);
    const newSocket = new MockWebSocket(WS_OPEN);

    handleAgentConnection(oldSocket, agentUrl());
    handleAgentConnection(newSocket, agentUrl());

    expect(agents.get('agent-1')?.ws).toBe(newSocket);
    expect(oldSocket.readyState).toBe(WS_CLOSED);
    expect(oldSocket.closeCode).toBe(1008);

    oldSocket.simulateMessage({
      type: 'yeaft_output',
      event: { type: 'yeaft_status', catalogEpoch: 'epoch-old' },
    });
    await settleMessages();

    expect(handleAgentOutput).not.toHaveBeenCalled();

    newSocket.simulateMessage({
      type: 'yeaft_output',
      event: { type: 'yeaft_status', catalogEpoch: 'epoch-new' },
    });
    await settleMessages();

    expect(handleAgentOutput).toHaveBeenCalledTimes(1);
    expect(handleAgentOutput.mock.calls[0][1].ws).toBe(newSocket);

    process.env.YEAFT_LOCAL_RUN = 'true';
    const localSocket = new MockWebSocket(WS_OPEN);
    handleAgentConnection(localSocket, agentUrl('local-agent'));
    expect(getOrCreateUser).toHaveBeenCalledWith('dev-user');
    expect(agents.get('local-agent')).toMatchObject({
      ownerId: 'local-user-id',
      ownerUsername: 'dev-user',
    });

    delete process.env.YEAFT_LOCAL_RUN;
    const genericSocket = new MockWebSocket(WS_OPEN);
    handleAgentConnection(genericSocket, agentUrl('generic-dev-agent'));
    expect(agents.get('generic-dev-agent')).toMatchObject({
      ownerId: null,
      ownerUsername: null,
    });
  });

  it('does not let an old close delete or rebroadcast over the replacement record', () => {
    const oldSocket = new MockWebSocket(WS_OPEN);
    const newSocket = new MockWebSocket(WS_OPEN);

    handleAgentConnection(oldSocket, agentUrl());
    handleAgentConnection(newSocket, agentUrl());
    broadcastAgentList.mockClear();

    oldSocket.emit('close', 1000, 'late old close');

    expect(agents.get('agent-1')?.ws).toBe(newSocket);
    expect(broadcastAgentList).not.toHaveBeenCalled();
  });

  it('applies the same replacement fence after authenticated registration', async () => {
    CONFIG.skipAuth = false;
    const oldSocket = new MockWebSocket(WS_OPEN);
    const newSocket = new MockWebSocket(WS_OPEN);

    handleAgentConnection(oldSocket, agentUrl());
    authenticate(oldSocket);
    await settleMessages();
    handleAgentConnection(newSocket, agentUrl());
    authenticate(newSocket);
    await settleMessages();

    const scopedAgentId = 'owner-1:agent-1';
    expect(agents.get(scopedAgentId)?.ws).toBe(newSocket);
    expect(oldSocket.readyState).toBe(WS_CLOSED);
    expect(oldSocket.closeCode).toBe(1008);

    oldSocket.simulateMessage({
      type: 'yeaft_output',
      event: { type: 'yeaft_status', catalogEpoch: 'epoch-old' },
    });
    await settleMessages();

    expect(handleAgentOutput).not.toHaveBeenCalled();

    newSocket.simulateMessage({
      type: 'yeaft_output',
      event: { type: 'yeaft_status', catalogEpoch: 'epoch-new' },
    });
    await settleMessages();

    expect(handleAgentOutput).toHaveBeenCalledTimes(1);
    expect(handleAgentOutput.mock.calls[0][1].ws).toBe(newSocket);
  });
});
