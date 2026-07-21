import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import ctx from '../../agent/context.js';

const sockets = [];
const parseQueue = [];
const handleMessage = vi.fn(async () => {});

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    sockets.push(this);
  }

  send(data) {
    this.sent.push(data);
  }
}

vi.mock('ws', () => ({ default: FakeWebSocket }));
vi.mock('../../agent/connection/buffer.js', () => ({
  BUFFERABLE_TYPES: new Set(),
  flushMessageBuffer: vi.fn(),
  sendToServer: vi.fn(),
  parseMessage: vi.fn(() => new Promise(resolve => parseQueue.push(resolve))),
}));
vi.mock('../../agent/connection/heartbeat.js', () => ({
  startAgentHeartbeat: vi.fn(),
  stopAgentHeartbeat: vi.fn(),
  scheduleReconnect: vi.fn(),
}));
vi.mock('../../agent/connection/message-router.js', () => ({ handleMessage }));
vi.mock('../../agent/connection/upgrade.js', () => ({
  handleRestartAgent: vi.fn(),
  handleUpgradeAgent: vi.fn(),
}));

const { connect } = await import('../../agent/connection/index.js');

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

beforeEach(() => {
  sockets.length = 0;
  parseQueue.length = 0;
  handleMessage.mockClear();
  ctx.ws = null;
  ctx.sessionKey = null;
  ctx.reconnectTimer = null;
  ctx.CONFIG = {
    serverUrl: 'ws://localhost:3456',
    instanceId: 'instance-1',
    agentName: 'Agent',
    workDir: '/tmp',
    disallowedTools: [],
    agentSecret: 'secret',
  };
  ctx.agentCapabilities = [];
  ctx.agentVersion = '1.0.0';
});

afterEach(() => {
  ctx.ws = null;
});

describe('Agent stale socket fence', () => {
  it('drops a command whose parse completes after a replacement socket is installed', async () => {
    connect();
    const oldSocket = sockets[0];
    oldSocket.emit('message', Buffer.from('{"encrypted":true}'));
    expect(parseQueue).toHaveLength(1);

    connect();
    expect(ctx.ws).toBe(sockets[1]);

    parseQueue[0]({ type: 'update_llm_config', config: { primaryModel: 'stale/model' } });
    await flush();

    expect(handleMessage).not.toHaveBeenCalled();
  });
});
