import { stmts, transaction } from './connection.js';
import { chatCatalogKey, yeaftCatalogKey } from '../session-catalog.js';

function normalizeMetadataUpdate(update) {
  if (!update?.catalogKey) throw new Error('Catalog metadata update requires catalogKey');
  if (!['yeaft', 'claude-code', 'copilot'].includes(update.runtimeProvider)) {
    throw new Error('Unknown Session runtime provider during metadata update');
  }
  return {
    ...update,
    pinned: typeof update.pinned === 'boolean' ? update.pinned : null,
    hidden: typeof update.hidden === 'boolean' ? update.hidden : null,
    hasSortRank: Object.prototype.hasOwnProperty.call(update, 'sortRank'),
    sortRank: Number.isFinite(update.sortRank) ? update.sortRank : null,
  };
}

export function applySessionUiMetadataUpdates(userId, updates, now = Date.now()) {
  if (!userId || !Array.isArray(updates) || updates.length === 0) return false;
  for (const rawUpdate of updates) {
    const update = normalizeMetadataUpdate(rawUpdate);
    const existing = stmts.getSessionUiMetadata.get(userId, update.catalogKey);
    const pinned = update.pinned ?? (existing?.pinned === 1);
    const hidden = update.hidden ?? (existing?.is_hidden === 1);
    const sortRank = update.hasSortRank
      ? update.sortRank
      : (Number.isFinite(existing?.sort_rank) ? existing.sort_rank : null);
    stmts.upsertSessionUiMetadata.run(
      userId,
      update.catalogKey,
      pinned ? 1 : 0,
      hidden ? 1 : 0,
      sortRank,
      now,
    );
    if (update.runtimeProvider === 'yeaft') {
      const result = stmts.setYeaftSessionPinnedForAgent.run(
        pinned ? 1 : 0,
        now,
        update.sessionId,
        userId,
        update.agentId,
      );
      if (result.changes !== 1) throw new Error('Yeaft Session identity changed during metadata update');
    } else {
      const result = stmts.updateSessionPinnedForRoute.run(
        pinned ? 1 : 0,
        now,
        update.sessionId,
        update.agentId,
        userId,
      );
      if (result.changes !== 1) throw new Error('Chat Session identity changed during metadata update');
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
    hidden: row.is_hidden === 1,
    sortRank: Number.isFinite(row.sort_rank) ? row.sort_rank : null,
    updatedAt: row.updated_at,
  };
}

export const sessionUiMetadataDb = {
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

  deleteForRoute(userId, { runtimeProvider, agentId, sessionId } = {}) {
    if (!userId || !agentId || !sessionId) return false;
    const catalogKey = runtimeProvider === 'yeaft'
      ? yeaftCatalogKey(agentId, sessionId)
      : chatCatalogKey(sessionId);
    return this.delete(userId, catalogKey);
  },
};
