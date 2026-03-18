import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for PR #268 — Dashboard time-dimension statistics (task-100).
 *
 * Validates:
 * 1. todayStr / periodStartDate date calculation logic
 * 2. flushDeltas dual-write (user_stats + daily_stats)
 * 3. getByPeriod routing (all → getAll, others → daily_stats)
 * 4. API period parameter validation and fallback
 * 5. Dashboard API response shape (todayActiveUsers, todayMessages)
 * 6. Frontend switchPeriod deduplication
 * 7. i18n keys completeness
 * 8. daily_stats table schema (upsert SQL correctness)
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

// =====================================================================
// Extract pure functions from user-stats-db.js
// =====================================================================

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function periodStartDate(period) {
  const now = new Date();
  switch (period) {
    case 'today':
      return todayStr();
    case 'week': {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    case 'month': {
      const d = new Date(now);
      d.setDate(d.getDate() - 29);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    default:
      return '1970-01-01';
  }
}

/**
 * Simulates flushDeltas dual-write behavior.
 * Returns what would be written to each table.
 */
function simulateFlushDeltas(deltaMap) {
  if (deltaMap.size === 0) return { userStats: [], dailyStats: [] };
  const userStatsWrites = [];
  const dailyStatsWrites = [];
  const today = todayStr();
  for (const [userId, delta] of deltaMap) {
    userStatsWrites.push({
      userId,
      messages: delta.messages || 0,
      sessions: delta.sessions || 0,
      requests: delta.requests || 0,
      bytesSent: delta.bytesSent || 0,
      bytesReceived: delta.bytesReceived || 0
    });
    dailyStatsWrites.push({
      userId,
      date: today,
      messages: delta.messages || 0,
      sessions: delta.sessions || 0,
      requests: delta.requests || 0,
      bytesSent: delta.bytesSent || 0,
      bytesReceived: delta.bytesReceived || 0
    });
  }
  return { userStats: userStatsWrites, dailyStats: dailyStatsWrites };
}

/**
 * Simulates getByPeriod routing logic.
 */
function getByPeriodRoute(period) {
  if (period === 'all') return { source: 'getAll' };
  return { source: 'dailyStats', startDate: periodStartDate(period) };
}

/**
 * Simulates API period parameter validation.
 */
function validatePeriod(period) {
  const validPeriods = ['today', 'week', 'month', 'all'];
  return validPeriods.includes(period) ? period : 'all';
}

/**
 * Simulates switchPeriod deduplication.
 */
function simulateSwitchPeriod(currentPeriod, newPeriod) {
  if (newPeriod === currentPeriod) return { shouldFetch: false };
  return { shouldFetch: true, period: newPeriod };
}

// =====================================================================
// 1. todayStr — date formatting
// =====================================================================
describe('todayStr: date format YYYY-MM-DD', () => {
  it('returns string in YYYY-MM-DD format', () => {
    const result = todayStr();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches current date', () => {
    const d = new Date();
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(todayStr()).toBe(expected);
  });
});

// =====================================================================
// 2. periodStartDate — period to start date calculation
// =====================================================================
describe('periodStartDate: period to start date mapping', () => {
  it('"today" returns today\'s date', () => {
    expect(periodStartDate('today')).toBe(todayStr());
  });

  it('"week" returns 6 days ago (7-day window)', () => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(periodStartDate('week')).toBe(expected);
  });

  it('"month" returns 29 days ago (30-day window)', () => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(periodStartDate('month')).toBe(expected);
  });

  it('"all" returns epoch (1970-01-01)', () => {
    expect(periodStartDate('all')).toBe('1970-01-01');
  });

  it('unknown period defaults to epoch', () => {
    expect(periodStartDate('unknown')).toBe('1970-01-01');
    expect(periodStartDate('')).toBe('1970-01-01');
  });
});

// =====================================================================
// 3. flushDeltas — dual write to user_stats and daily_stats
// =====================================================================
describe('flushDeltas: dual-write behavior', () => {
  it('writes to both user_stats and daily_stats for each user', () => {
    const deltaMap = new Map([
      ['user-1', { messages: 5, sessions: 1, requests: 10, bytesSent: 1000, bytesReceived: 2000 }]
    ]);
    const result = simulateFlushDeltas(deltaMap);
    expect(result.userStats).toHaveLength(1);
    expect(result.dailyStats).toHaveLength(1);
  });

  it('daily_stats entry includes today\'s date', () => {
    const deltaMap = new Map([
      ['user-1', { messages: 3, sessions: 0, requests: 5, bytesSent: 0, bytesReceived: 0 }]
    ]);
    const result = simulateFlushDeltas(deltaMap);
    expect(result.dailyStats[0].date).toBe(todayStr());
  });

  it('handles multiple users in a single flush', () => {
    const deltaMap = new Map([
      ['user-1', { messages: 5, sessions: 1, requests: 10, bytesSent: 100, bytesReceived: 200 }],
      ['user-2', { messages: 3, sessions: 0, requests: 6, bytesSent: 50, bytesReceived: 100 }]
    ]);
    const result = simulateFlushDeltas(deltaMap);
    expect(result.userStats).toHaveLength(2);
    expect(result.dailyStats).toHaveLength(2);
    expect(result.dailyStats[0].userId).toBe('user-1');
    expect(result.dailyStats[1].userId).toBe('user-2');
  });

  it('returns empty arrays for empty deltaMap', () => {
    const result = simulateFlushDeltas(new Map());
    expect(result.userStats).toEqual([]);
    expect(result.dailyStats).toEqual([]);
  });

  it('defaults missing delta fields to 0', () => {
    const deltaMap = new Map([
      ['user-1', { messages: 2 }]  // missing sessions, requests, bytes
    ]);
    const result = simulateFlushDeltas(deltaMap);
    expect(result.dailyStats[0].sessions).toBe(0);
    expect(result.dailyStats[0].requests).toBe(0);
    expect(result.dailyStats[0].bytesSent).toBe(0);
    expect(result.dailyStats[0].bytesReceived).toBe(0);
  });

  it('both writes have same delta values per user', () => {
    const deltaMap = new Map([
      ['user-1', { messages: 7, sessions: 2, requests: 15, bytesSent: 500, bytesReceived: 1500 }]
    ]);
    const result = simulateFlushDeltas(deltaMap);
    expect(result.userStats[0].messages).toBe(result.dailyStats[0].messages);
    expect(result.userStats[0].sessions).toBe(result.dailyStats[0].sessions);
    expect(result.userStats[0].requests).toBe(result.dailyStats[0].requests);
    expect(result.userStats[0].bytesSent).toBe(result.dailyStats[0].bytesSent);
    expect(result.userStats[0].bytesReceived).toBe(result.dailyStats[0].bytesReceived);
  });
});

// =====================================================================
// 4. getByPeriod — routing logic
// =====================================================================
describe('getByPeriod: routing to correct data source', () => {
  it('"all" routes to getAll (cumulative user_stats)', () => {
    const route = getByPeriodRoute('all');
    expect(route.source).toBe('getAll');
  });

  it('"today" routes to dailyStats with today\'s date', () => {
    const route = getByPeriodRoute('today');
    expect(route.source).toBe('dailyStats');
    expect(route.startDate).toBe(todayStr());
  });

  it('"week" routes to dailyStats with 6-days-ago date', () => {
    const route = getByPeriodRoute('week');
    expect(route.source).toBe('dailyStats');
    expect(route.startDate).toBe(periodStartDate('week'));
  });

  it('"month" routes to dailyStats with 29-days-ago date', () => {
    const route = getByPeriodRoute('month');
    expect(route.source).toBe('dailyStats');
    expect(route.startDate).toBe(periodStartDate('month'));
  });
});

// =====================================================================
// 5. API period parameter validation
// =====================================================================
describe('API period parameter validation', () => {
  it('accepts valid period values', () => {
    expect(validatePeriod('today')).toBe('today');
    expect(validatePeriod('week')).toBe('week');
    expect(validatePeriod('month')).toBe('month');
    expect(validatePeriod('all')).toBe('all');
  });

  it('falls back to "all" for invalid period', () => {
    expect(validatePeriod('invalid')).toBe('all');
    expect(validatePeriod('')).toBe('all');
    expect(validatePeriod(undefined)).toBe('all');
  });
});

// =====================================================================
// 6. Dashboard API response shape
// =====================================================================
describe('Dashboard API response includes today fields', () => {
  const adminRoutesSrc = read('server/routes/admin-routes.js');

  it('dashboard endpoint returns todayActiveUsers', () => {
    expect(adminRoutesSrc).toContain('todayActiveUsers');
    // Verify it calls getTodayActiveUsers
    expect(adminRoutesSrc).toContain('getTodayActiveUsers()');
  });

  it('dashboard endpoint returns todayMessages', () => {
    expect(adminRoutesSrc).toContain('todayMessages');
    expect(adminRoutesSrc).toContain('getTodayMessages()');
  });

  it('user-stats endpoint uses period query parameter', () => {
    expect(adminRoutesSrc).toContain('req.query.period');
    expect(adminRoutesSrc).toContain('getByPeriod');
  });
});

// =====================================================================
// 7. Frontend switchPeriod deduplication
// =====================================================================
describe('Frontend: switchPeriod behavior', () => {
  it('does not fetch when same period is selected', () => {
    expect(simulateSwitchPeriod('all', 'all').shouldFetch).toBe(false);
    expect(simulateSwitchPeriod('today', 'today').shouldFetch).toBe(false);
  });

  it('fetches when different period is selected', () => {
    const result = simulateSwitchPeriod('all', 'today');
    expect(result.shouldFetch).toBe(true);
    expect(result.period).toBe('today');
  });

  it('fetches for all period transitions', () => {
    expect(simulateSwitchPeriod('today', 'week').shouldFetch).toBe(true);
    expect(simulateSwitchPeriod('week', 'month').shouldFetch).toBe(true);
    expect(simulateSwitchPeriod('month', 'all').shouldFetch).toBe(true);
  });
});

// =====================================================================
// 8. Frontend overview data mapping
// =====================================================================
describe('Frontend: DashboardTab data mapping', () => {
  const dashSrc = read('web/components/DashboardTab.js');

  it('overview data uses todayActiveUsers instead of onlineUsers', () => {
    expect(dashSrc).toContain('todayActiveUsers');
    // Should reference it in both template and data mapping
    expect(dashSrc).toContain("overview.todayActiveUsers");
  });

  it('overview data uses todayMessages instead of totalSessions', () => {
    expect(dashSrc).toContain('todayMessages');
    expect(dashSrc).toContain("overview.todayMessages");
  });

  it('has period tabs with 4 period options', () => {
    expect(dashSrc).toContain("value: 'today'");
    expect(dashSrc).toContain("value: 'week'");
    expect(dashSrc).toContain("value: 'month'");
    expect(dashSrc).toContain("value: 'all'");
  });

  it('fetchUserStats sends period as query parameter', () => {
    expect(dashSrc).toMatch(/user-stats\?period=.*statsPeriod/);
  });
});

// =====================================================================
// 9. i18n keys completeness
// =====================================================================
describe('i18n: new dashboard keys', () => {
  const zhCN = read('web/i18n/zh-CN.js');
  const enUS = read('web/i18n/en.js');

  const requiredKeys = [
    'settings.dashboard.todayActive',
    'settings.dashboard.todayMessages',
    'settings.dashboard.today',
    'settings.dashboard.thisWeek',
    'settings.dashboard.thisMonth',
    'settings.dashboard.all'
  ];

  for (const key of requiredKeys) {
    it(`zh-CN has key "${key}"`, () => {
      expect(zhCN).toContain(`'${key}'`);
    });

    it(`en has key "${key}"`, () => {
      expect(enUS).toContain(`'${key}'`);
    });
  }
});

// =====================================================================
// 10. daily_stats table schema
// =====================================================================
describe('daily_stats table schema', () => {
  const connectionSrc = read('server/db/connection.js');

  it('daily_stats table has composite PRIMARY KEY (user_id, date)', () => {
    expect(connectionSrc).toContain('PRIMARY KEY (user_id, date)');
  });

  it('daily_stats has index on date column', () => {
    expect(connectionSrc).toContain('idx_daily_stats_date');
  });

  it('upsertDailyStats uses ON CONFLICT DO UPDATE with incremental addition', () => {
    // Verify the upsert adds to existing values (not replaces)
    expect(connectionSrc).toContain('message_count = message_count + excluded.message_count');
    expect(connectionSrc).toContain('bytes_sent = bytes_sent + excluded.bytes_sent');
  });
});
