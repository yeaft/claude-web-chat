import { beforeEach, describe, expect, it, vi } from 'vitest';

let context;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  context = await import('../../server/context.js');
  context.userStatsDeltas.clear();
});

describe('dashboard usage accounting', () => {
  it('excludes heartbeat frames from request stats', () => {
    context.trackRequest('u1', 12, 'ping');
    context.trackRequest('u1', 12, 'pong_session');
    context.trackRequest('u1', 20, 'chat');

    expect(context.isHeartbeatMessageType('ping')).toBe(true);
    expect(context.userStatsDeltas.get('u1')).toMatchObject({
      requests: 1,
      bytesReceived: 0,
      messages: 0,
    });
  });

  it('counts user turns and message traffic bytes separately', () => {
    context.trackUserTurn('u1', 123);
    context.trackMessageBytesSent('u1', 456, 'yeaft_output');
    context.trackMessageBytesSent('u1', 999, 'pong_session');
    context.trackMessageBytesSent('u1', 888, 'agent_list');

    expect(context.userStatsDeltas.get('u1')).toMatchObject({
      messages: 1,
      bytesReceived: 123,
      bytesSent: 456,
    });
  });

  it('dashboard user stats include unflushed deltas', async () => {
    vi.doMock('../../server/database.js', () => ({
      userStatsDb: {
        getDashboardTotals: () => ({ total_users: 1, total_sessions: 0, total_messages: 0 }),
        getTodayActiveUsers: () => 1,
        getTodayMessages: () => 2,
        getByPeriod: () => ([{
          user_id: 'u1',
          username: 'linus',
          display_name: 'Linus',
          role: 'admin',
          message_count: 3,
          session_count: 1,
          request_count: 4,
          bytes_sent: 5,
          bytes_received: 6,
          last_login_at: 7,
          updated_at: 8,
        }]),
      },
    }));

    const { registerAdminRoutes } = await import('../../server/routes/admin-routes.js');
    const handlers = new Map();
    const app = { get: (path, ...fns) => handlers.set(path, fns[fns.length - 1]) };
    registerAdminRoutes(app, {
      requireAuth: (_req, _res, next) => next(),
      requireAdmin: (_req, _res, next) => next(),
    });

    context.trackUserTurn('u1', 100);
    context.trackRequest('u1', 0, 'chat');
    context.trackMessageBytesSent('u1', 200, 'claude_output');
    context.agents.set('agent-1', {
      ws: { readyState: 1 },
      name: 'agent-1',
      conversations: new Map(),
      metrics: {
        chatTurns: 2,
        yeaftTurns: 3,
        totalTurns: 5,
        sessionsCreated: 4,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        totalTokens: 155,
        lastUpdatedAt: 123,
      },
    });

    let body = null;
    const res = { json: (payload) => { body = payload; }, status: () => res };
    handlers.get('/api/admin/user-stats')({ query: { period: 'today' } }, res);

    expect(body).toEqual([expect.objectContaining({
      userId: 'u1',
      messageCount: 4,
      requestCount: 5,
      bytesSent: 205,
      bytesReceived: 106,
    })]);

    handlers.get('/api/admin/dashboard')({ query: {} }, res);
    expect(body.todayMessages).toBe(3);
    expect(body.agentMetrics).toMatchObject({
      chatTurns: 2,
      yeaftTurns: 3,
      totalTurns: 5,
      sessionsCreated: 4,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 155,
    });
    expect(body.totalAgentTurns).toBe(5);
    expect(body.totalTokens).toBe(155);

    handlers.get('/api/admin/agents')({ query: {} }, res);
    expect(body).toEqual([expect.objectContaining({
      id: 'agent-1',
      metrics: expect.objectContaining({ totalTurns: 5, totalTokens: 155 }),
    })]);
  });
});
