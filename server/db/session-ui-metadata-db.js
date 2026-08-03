import { stmts, transaction } from './connection.js';

export function applySessionUiMetadataUpdates(userId, updates, now = Date.now()) {
  if (!userId || !Array.isArray(updates) || updates.length === 0) return false;
  for (const update of updates) {
    if (!update?.catalogKey) throw new Error('Catalog metadata update requires catalogKey');
    stmts.upsertSessionUiMetadata.run(
      userId,
      update.catalogKey,
      update.pinned === true ? 1 : 0,
      Number.isFinite(update.sortRank) ? update.sortRank : null,
      now,
    );
    if (update.runtimeProvider === 'yeaft') {
      const result = stmts.setYeaftSessionPinnedForAgent.run(
        update.pinned === true ? 1 : 0,
        now,
        update.sessionId,
        userId,
        update.agentId,
      );
      if (result.changes !== 1) throw new Error('Yeaft Session identity changed during metadata update');
    } else if (update.runtimeProvider === 'claude-code' || update.runtimeProvider === 'copilot') {
      const result = stmts.updateSessionPinnedForRoute.run(
        update.pinned === true ? 1 : 0,
        now,
        update.sessionId,
        update.agentId,
        userId,
      );
      if (result.changes !== 1) throw new Error('Chat Session identity changed during metadata update');
    } else {
      throw new Error('Unknown Session runtime provider during metadata update');
    }
  }
  return true;
}

function mapRow(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    catalogKey: row.catalog_key,
    pinned: row.pinned === 1,
    sortRank: Number.isFinite(row.sort_rank) ? row.sort_rank : null,
    updatedAt: row.updated_at,
  };
}

export const sessionUiMetadataDb = {
  upsert(userId, catalogKey, { pinned = false, sortRank = null } = {}) {
    if (!userId || !catalogKey) return false;
    stmts.upsertSessionUiMetadata.run(
      userId,
      catalogKey,
      pinned ? 1 : 0,
      Number.isFinite(sortRank) ? sortRank : null,
      Date.now(),
    );
    return true;
  },

  get(userId, catalogKey) {
    if (!userId || !catalogKey) return null;
    return mapRow(stmts.getSessionUiMetadata.get(userId, catalogKey));
  },

  getByUser(userId) {
    if (!userId) return [];
    return stmts.getSessionUiMetadataByUser.all(userId).map(mapRow);
  },

  applyBatch(userId, updates) {
    if (!userId || !Array.isArray(updates) || updates.length === 0) return false;
    return transaction(() => applySessionUiMetadataUpdates(userId, updates))();
  },

  delete(userId, catalogKey) {
    if (!userId || !catalogKey) return false;
    return stmts.deleteSessionUiMetadata.run(userId, catalogKey).changes > 0;
  },
};
