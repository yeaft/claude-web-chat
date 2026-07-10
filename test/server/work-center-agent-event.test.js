import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const agents = new Map();
const webClients = new Map();

vi.mock('../../server/config.js', () => ({ CONFIG: { skipAuth: false } }));
vi.mock('../../server/database.js', () => ({ sessionDb: {} }));
vi.mock('../../server/encryption.js', () => ({
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  isEncrypted: vi.fn(() => false),
  encodeKey: vi.fn(),
}));
vi.mock('../../server/context.js', () => ({
  agents,
  webClients,
  directoryCache: new Map(),
  DIR_CACHE_TTL: 1,
  DIR_CACHE_MAX_SIZE: 1,
  trackMessageBytesSent: vi.fn(),
}));

const { forwardAgentEvent } = await import('../../server/ws-utils.js');

function client(userId, role) {
  return {
    authenticated: true,
    userId,
    role,
    encryptOutbound: false,
    ws: { readyState: WebSocket.OPEN, send: vi.fn() },
  };
}

describe('Work Center Agent event authorization', () => {
  beforeEach(() => {
    agents.clear();
    webClients.clear();
  });

  it('sends ownerless global Agent events only to admins', async () => {
    agents.set('global-agent', { ownerId: null });
    const admin = client('admin-user', 'admin');
    const regular = client('regular-user', 'pro');
    const anonymous = { ...client(null, null), authenticated: false };
    webClients.set('admin', admin);
    webClients.set('regular', regular);
    webClients.set('anonymous', anonymous);

    await forwardAgentEvent('global-agent', { type: 'work_center_event', agentId: 'global-agent' });

    expect(admin.ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(admin.ws.send.mock.calls[0][0])).toEqual({
      type: 'work_center_event', agentId: 'global-agent',
    });
    expect(regular.ws.send).not.toHaveBeenCalled();
    expect(anonymous.ws.send).not.toHaveBeenCalled();
  });

  it('sends owned Agent events to the owner and not to unrelated admins', async () => {
    agents.set('owned-agent', { ownerId: 'owner-user' });
    const owner = client('owner-user', 'pro');
    const admin = client('admin-user', 'admin');
    webClients.set('owner', owner);
    webClients.set('admin', admin);

    await forwardAgentEvent('owned-agent', { type: 'work_center_event', agentId: 'owned-agent' });

    expect(owner.ws.send).toHaveBeenCalledTimes(1);
    expect(admin.ws.send).not.toHaveBeenCalled();
  });
});
