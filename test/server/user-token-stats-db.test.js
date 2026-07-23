import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dbDir = mkdtempSync(join(tmpdir(), 'yeaft-user-token-stats-'));
process.env.TEST_DB_DIR = dbDir;
process.env.TEST_DB_PATH = join(dbDir, 'stats.db');

let db;
let userStatsDb;

beforeAll(async () => {
  ({ default: db } = await import('../../server/db/connection.js'));
  ({ userStatsDb } = await import('../../server/db/user-stats-db.js'));
  db.prepare(`
    INSERT INTO users (id, username, display_name, created_at, role)
    VALUES (?, ?, ?, ?, ?)
  `).run('u1', 'linus', 'Linus', Date.now(), 'admin');
});

afterAll(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
});

describe('per-user token persistence', () => {
  it('persists only monotonic deltas within one agent process epoch', () => {
    const first = userStatsDb.recordAgentTokenSnapshot('u1', 'instance-1', {
      metricEpoch: 'epoch-1',
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 155,
    });
    const repeated = userStatsDb.recordAgentTokenSnapshot('u1', 'instance-1', {
      metricEpoch: 'epoch-1',
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 155,
    });
    const stale = userStatsDb.recordAgentTokenSnapshot('u1', 'instance-1', {
      metricEpoch: 'epoch-1',
      inputTokens: 90,
      outputTokens: 30,
      cacheReadTokens: 8,
      cacheWriteTokens: 4,
      totalTokens: 132,
    });
    const next = userStatsDb.recordAgentTokenSnapshot('u1', 'instance-1', {
      metricEpoch: 'epoch-1',
      inputTokens: 120,
      outputTokens: 50,
      cacheReadTokens: 12,
      cacheWriteTokens: 6,
      totalTokens: 188,
    });

    expect(first).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      totalTokens: 155,
    });
    expect(repeated).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    });
    expect(stale.totalTokens).toBe(0);
    expect(next).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 33,
    });

    expect(userStatsDb.getByUserId('u1')).toMatchObject({
      input_tokens: 120,
      output_tokens: 50,
      cache_read_tokens: 12,
      cache_write_tokens: 6,
      total_tokens: 188,
    });
  });

  it('starts a new watermark when the agent process epoch changes', () => {
    userStatsDb.recordAgentTokenSnapshot('u1', 'instance-1', {
      metricEpoch: 'epoch-2',
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 10,
    });

    expect(userStatsDb.getByUserId('u1')).toMatchObject({
      input_tokens: 127,
      output_tokens: 53,
      cache_read_tokens: 12,
      cache_write_tokens: 6,
      total_tokens: 198,
    });
    expect(userStatsDb.getByPeriod('today')[0]).toMatchObject({
      user_id: 'u1',
      input_tokens: 127,
      output_tokens: 53,
      total_tokens: 198,
    });
    expect(userStatsDb.getDashboardTokenTotals()).toMatchObject({
      total_tokens: 198,
    });
  });
});
