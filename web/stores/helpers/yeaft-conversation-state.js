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

function moveMapEntry(map, sourceConversationId, targetConversationId, { removeSource, transferRuntime }) {
  if (!map || !Object.prototype.hasOwnProperty.call(map, sourceConversationId)) return;
  if (transferRuntime) {
    map[targetConversationId] = removeSource
      ? map[sourceConversationId]
      : copyRuntimeValue(map[sourceConversationId]);
  }
  if (removeSource) delete map[sourceConversationId];
}

/**
 * Move every Web runtime state slot that follows a Yeaft bridge conversation.
 * The Agent id remains the authority outside this helper; this function only
 * moves one already-validated source conversation into its replacement.
 */
export function pendingYeaftConversationPromotion(store, agentId, targetConversationId = null) {
  if (!agentId) return null;
  const pending = store?._yeaftPendingConversationPromotions?.[agentId] || null;
  if (!pending?.sourceConversationId || !pending.targetConversationId) return null;
  if (targetConversationId && pending.targetConversationId !== targetConversationId) return null;
  return pending;
}

export function rememberYeaftConversationPromotion(store, agentId, sourceConversationId, targetConversationId) {
  if (!agentId || !sourceConversationId || !targetConversationId || sourceConversationId === targetConversationId) return false;
  store._yeaftPendingConversationPromotions = {
    ...(store._yeaftPendingConversationPromotions || {}),
    [agentId]: { sourceConversationId, targetConversationId },
  };
  return true;
}

export function clearYeaftConversationPromotion(store, agentId, targetConversationId = null) {
  const pending = pendingYeaftConversationPromotion(store, agentId, targetConversationId);
  if (!pending) return null;
  const next = { ...(store._yeaftPendingConversationPromotions || {}) };
  delete next[agentId];
  store._yeaftPendingConversationPromotions = next;
  return pending;
}

export function migrateYeaftConversationState(store, sourceConversationId, targetConversationId, {
  removeSource = true,
} = {}) {
  if (!sourceConversationId || !targetConversationId || sourceConversationId === targetConversationId) return false;

  mergeRows(store, sourceConversationId, targetConversationId);
  const targetHasProcessing = Object.prototype.hasOwnProperty.call(store.processingConversations || {}, targetConversationId);
  const targetHasExecution = Object.prototype.hasOwnProperty.call(store.executionStatusMap || {}, targetConversationId);
  const targetHasHealth = Object.prototype.hasOwnProperty.call(store.sessionHealth || {}, targetConversationId);
  const targetOwnsRuntime = targetHasProcessing || targetHasExecution;
  const transferRuntime = !removeSource || !targetOwnsRuntime;
  moveMapEntry(store.processingConversations, sourceConversationId, targetConversationId, { removeSource, transferRuntime });
  moveMapEntry(store.executionStatusMap, sourceConversationId, targetConversationId, { removeSource, transferRuntime });
  const sourceHealth = store.sessionHealth?.[sourceConversationId];
  moveMapEntry(store.refreshingSessionMap, sourceConversationId, targetConversationId, { removeSource, transferRuntime });
  moveMapEntry(store._closedAt, sourceConversationId, targetConversationId, { removeSource, transferRuntime });
  moveMapEntry(store._autoRefreshed, sourceConversationId, targetConversationId, { removeSource, transferRuntime });

  if (store._turnCompletedConvs?.has(sourceConversationId)) {
    if (transferRuntime) store._turnCompletedConvs.add(targetConversationId);
    if (removeSource) store._turnCompletedConvs.delete(sourceConversationId);
  }

  const sourceUsesYeaftWatchdog = !!store._yeaftWatchdogConvs?.has(sourceConversationId);
  const hadWatchdog = !!store._processingWatchdogs?.[sourceConversationId];
  if (removeSource && hadWatchdog) stopProcessingWatchdog(store, sourceConversationId);
  if (removeSource && store._pongTimeouts?.[sourceConversationId]) {
    clearTimeout(store._pongTimeouts[sourceConversationId]);
    delete store._pongTimeouts[sourceConversationId];
  }
  if (hadWatchdog && removeSource && transferRuntime && store.processingConversations?.[targetConversationId]) {
    startYeaftWatchdog(store, targetConversationId);
  } else if (sourceUsesYeaftWatchdog && removeSource && targetOwnsRuntime
      && store.processingConversations?.[targetConversationId]) {
    if (store._processingWatchdogs?.[targetConversationId]) {
      store._yeaftWatchdogConvs?.add(targetConversationId);
    } else {
      startYeaftWatchdog(store, targetConversationId);
    }
  }
  if (sourceHealth) {
    if (!store.sessionHealth) store.sessionHealth = {};
    if (!targetHasHealth) store.sessionHealth[targetConversationId] = sourceHealth;
    if (removeSource) delete store.sessionHealth[sourceConversationId];
  }

  if (removeSource && store.messagesMap) delete store.messagesMap[sourceConversationId];
  return true;
}
