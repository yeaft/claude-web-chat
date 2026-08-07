const LEGACY_DATABASE_NAME = 'yeaft-history-cache';
const CLEANUP_MARKER = 'yeaft-history-cache-removed-v1';
let cleanupStarted = false;

/**
 * Best-effort removal of the retired browser transcript database.
 *
 * Conversation history is Agent-owned. Startup and authentication must never
 * wait for an old browser cache (or another tab holding that database open).
 */
export function removeLegacyYeaftHistoryDatabase() {
  if (cleanupStarted) return false;
  cleanupStarted = true;

  let storage = null;
  try {
    storage = globalThis.localStorage || null;
    if (storage?.getItem(CLEANUP_MARKER) === 'done') return false;
  } catch {
    storage = null;
  }

  const indexedDb = globalThis.indexedDB;
  if (!indexedDb || typeof indexedDb.deleteDatabase !== 'function') {
    try { storage?.setItem(CLEANUP_MARKER, 'done'); } catch {}
    return false;
  }

  try {
    const request = indexedDb.deleteDatabase(LEGACY_DATABASE_NAME);
    request.onsuccess = () => {
      try { storage?.setItem(CLEANUP_MARKER, 'done'); } catch {}
    };
    request.onerror = () => {
      console.warn('[Yeaft] retired browser history database cleanup failed');
    };
    request.onblocked = () => {
      console.warn('[Yeaft] retired browser history database cleanup is blocked by another tab');
    };
    return true;
  } catch {
    return false;
  }
}

export const __legacyYeaftHistoryCacheCleanupForTest = {
  databaseName: LEGACY_DATABASE_NAME,
  marker: CLEANUP_MARKER,
  reset() { cleanupStarted = false; },
};
