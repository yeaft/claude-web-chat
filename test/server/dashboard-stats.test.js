import { afterEach, describe, expect, it, vi } from 'vitest';

const { getByPeriod, getAllUsers, getDashboardTotals, getDashboardTokenTotals, getTodayActiveUsers, getTodayMessages } = vi.hoisted(() => ({
  getByPeriod: vi.fn(),
  getAllUsers: vi.fn(() => []),
  getDashboardTotals: vi.fn(() => ({ total_users: 1, total_sessions: 0, total_messages: 3 })),
  getDashboardTokenTotals: vi.fn(() => ({ total_tokens: 0 })),
  getTodayActiveUsers: vi.fn(() => 0),
  getTodayMessages: vi.fn(() => 3),
}));

vi.mock('../../server/database.js', () => ({
  userDb: { getAll: getAllUsers },
  userStatsDb: {
    getByPeriod,
    getDashboardTotals,
    getDashboardTokenTotals,
    getTodayActiveUsers,
    getTodayMessages,
  },
}));

const { userStatsDeltas, webClients, agents, trackUserTurn } = await import('../../server/context.js');
const { registerAdminRoutes } = await import('../../server/routes/admin-routes.js');

function installRoutes() {
  const routes = new Map();
  const app = {
    get(path, ...handlers) {
      routes.set(path, handlers.at(-1));
    },
  };
  registerAdminRoutes(app, { requireAuth: (_req, _res, next) => next?.(), requireAdmin: (_req, _res, next) => next?.() });
  return routes;
}

function response() {
  return {
    body: null,
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

afterEach(() => {
  userStatsDeltas.clear();
  webClients.clear();
  agents.clear();
  getByPeriod.mockReset();
  getAllUsers.mockReset();
  getAllUsers.mockReturnValue([]);
});

describe('Dashboard user statistics', () => {
  it('records requests only at the validated user-turn boundary', () => {
    trackUserTurn('user-1', 100);
    expect(userStatsDeltas.get('user-1')).toMatchObject({
      messages: 1,
      requests: 1,
      bytesReceived: 100,
    });

    // Echo/history/control frames never call trackUserTurn, so they cannot
    // inflate either counter through the WebSocket ingress path.
    expect(userStatsDeltas.get('user-1')).toMatchObject({ requests: 1, messages: 1 });
  });

  it('uses user turns for requestCount, omits sessions, and reports current connection state', async () => {
    getByPeriod.mockReturnValue([{
      user_id: 'user-1',
      username: 'alice',
      display_name: 'Alice',
      role: 'pro',
      message_count: 3,
      session_count: 9,
      request_count: 99,
      bytes_sent: 10,
      bytes_received: 20,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      last_login_at: 123,
      updated_at: 456,
    }]);
    getAllUsers.mockReturnValue([{
      id: 'user-2',
      username: 'bob',
      display_name: 'Bob',
      role: 'pro',
      last_login_at: null,
      created_at: 789,
    }]);
    userStatsDeltas.set('user-1', {
      messages: 2, sessions: 1, requests: 7, bytesSent: 1, bytesReceived: 2,
    });
    webClients.set('client-open', {
      authenticated: true,
      userId: 'user-1',
      ws: { readyState: 1 },
    });
    webClients.set('client-closed', {
      authenticated: true,
      userId: 'user-2',
      ws: { readyState: 3 },
    });

    const route = installRoutes().get('/api/admin/user-stats');
    const res = response();
    route({ query: { period: 'all' } }, res);

    expect(res.statusCode).toBe(200);
    const user = res.body.find(row => row.userId === 'user-1');
    expect(user).toEqual(expect.objectContaining({
      userId: 'user-1',
      messageCount: 5,
      requestCount: 5,
      active: true,
    }));
    expect(res.body.every(row => !Object.hasOwn(row, 'sessionCount'))).toBe(true);
    expect(res.body.find(row => row.userId === 'user-2')).toMatchObject({
      messageCount: 0,
      requestCount: 0,
      active: false,
    });
  });

  it('counts only open authenticated WebSocket users in the general overview', () => {
    webClients.set('client-open', {
      authenticated: true,
      userId: 'user-1',
      ws: { readyState: 1 },
    });
    webClients.set('client-closed', {
      authenticated: true,
      userId: 'user-2',
      ws: { readyState: 3 },
    });
    webClients.set('client-unauthenticated', {
      authenticated: false,
      userId: 'user-3',
      ws: { readyState: 1 },
    });

    const route = installRoutes().get('/api/admin/dashboard');
    const res = response();
    route({}, res);

    expect(res.body.onlineUsers).toBe(1);
  });
});
