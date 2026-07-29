import { stmts } from './connection.js';

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

  delete(userId, catalogKey) {
    if (!userId || !catalogKey) return false;
    return stmts.deleteSessionUiMetadata.run(userId, catalogKey).changes > 0;
  },
};
