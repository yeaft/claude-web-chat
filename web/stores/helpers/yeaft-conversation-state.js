import { mergeMessagesByStableId } from './messages.js';
import { startYeaftWatchdog, stopProcessingWatchdog } from './watchdog.js';

function mergeRows(store, sourceConversationId, targetConversationId) {
  const sourceRows = store.messagesMap?.[sourceConversationId] || [];
  const targetRows = store.messagesMap?.[targetConversationId] || [];
  if (!store.messagesMap) store.messagesMap = {};
  store.messagesMap[targetConversationId] = mergeMessagesByStableId(targetRows, sourceRows)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function copyRuntimeValue(value) {
  if (!value || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) {}
  }
  if (Array.isArray(value)) return value.slice();
  return { ...value };
}

function moveMapEntry(map, sourceConversationId, targetConversationId, { removeSource }) {
  if (!map || !Object.prototype.hasOwnProperty.call(map, sourceConversationId)) return;
  map[targetConversationId] = removeSource
    ? map[sourceConversationId]
    : copyRuntimeValue(map[sourceConversationId]);
  if (removeSource) delete map[sourceConversationId];
}

/**
 * Move every Web runtime state slot that follows a Yeaft bridge conversation.
 * The Agent id remains the authority outside this helper; this function only
 * moves one already-validated source conversation into its replacement.
 */
export function migrateYeaftConversationState(store, sourceConversationId, targetConversationId, {
  removeSource = true,
} = {}) {
  if (!sourceConversationId || !targetConversationId || sourceConversationId === targetConversationId) return false;

  mergeRows(store, sourceConversationId, targetConversationId);
  moveMapEntry(store.processingConversations, sourceConversationId, targetConversationId, { removeSource });
  moveMapEntry(store.executionStatusMap, sourceConversationId, targetConversationId, { removeSource });
  const sourceHealth = store.sessionHealth?.[sourceConversationId];
  moveMapEntry(store.refreshingSessionMap, sourceConversationId, targetConversationId, { removeSource });
  moveMapEntry(store._closedAt, sourceConversationId, targetConversationId, { removeSource });
  moveMapEntry(store._autoRefreshed, sourceConversationId, targetConversationId, { removeSource });

  if (store._turnCompletedConvs?.has(sourceConversationId)) {
    store._turnCompletedConvs.add(targetConversationId);
    if (removeSource) store._turnCompletedConvs.delete(sourceConversationId);
  }

  const hadWatchdog = !!store._processingWatchdogs?.[sourceConversationId];
  if (removeSource && hadWatchdog) stopProcessingWatchdog(store, sourceConversationId);
  if (removeSource && store._pongTimeouts?.[sourceConversationId]) {
    clearTimeout(store._pongTimeouts[sourceConversationId]);
    delete store._pongTimeouts[sourceConversationId];
  }
  if (hadWatchdog && removeSource && store.processingConversations?.[targetConversationId]) {
    startYeaftWatchdog(store, targetConversationId);
  }
  if (sourceHealth) {
    if (!store.sessionHealth) store.sessionHealth = {};
    store.sessionHealth[targetConversationId] = sourceHealth;
    if (removeSource) delete store.sessionHealth[sourceConversationId];
  }

  if (removeSource && store.messagesMap) delete store.messagesMap[sourceConversationId];
  return true;
}
