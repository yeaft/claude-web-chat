import db from './connection.js';
import { stmts } from './connection.js';

export const userStatsDb = {
  /**
   * Batch flush in-memory deltas to DB.
   * @param {Map<string, {requests: number, bytesSent: number, bytesReceived: number, messages: number, sessions: number}>} deltaMap
   */
  flushDeltas(deltaMap) {
    if (deltaMap.size === 0) return;

    const now = Date.now();
    const flush = db.transaction(() => {
      for (const [userId, delta] of deltaMap) {
        stmts.upsertUserStats.run(
          userId,
          delta.messages || 0,
          delta.sessions || 0,
          delta.requests || 0,
          delta.bytesSent || 0,
          delta.bytesReceived || 0,
          now
        );
      }
    });
    flush();
  },

  getAll() {
    return stmts.getUserStats.all();
  },

  getByUserId(userId) {
    return stmts.getUserStatsById.get(userId) || null;
  },

  getDashboardTotals() {
    return stmts.getDashboardTotals.get();
  }
};
