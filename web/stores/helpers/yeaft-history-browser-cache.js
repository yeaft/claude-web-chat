import {
  isDurableYeaftHistoryRow,
  yeaftHistoryRowSeq,
  yeaftHistoryUnitKey,
} from './yeaft-history-cache.js';

const DATABASE_NAME = 'yeaft-history-cache';
const DATABASE_VERSION = 2;
const SESSION_STORE = 'sessions';
const CACHE_SCHEMA_VERSION = 2;

export const YEAFT_HISTORY_BROWSER_CACHE_LIMITS = Object.freeze({
  maxSessionsPerOwner: 12,
  maxRowsPerSession: 600,
  maxBytesPerSession: 4 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
});

let browserOwnerId = null;
let browserOwnerEpoch = 0;
let databasePromise = null;
let ownerCleanupPromise = Promise.resolve(true);
let fullCleanupRequired = false;

function normalizeId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function identityKey(ownerId, agentId, sessionId) {
  return [ownerId, agentId, sessionId].map(value => String(value || '')).join('\u001f');
}

function cacheDatabase() {
  return globalThis.indexedDB || null;
}

function cacheAvailable() {
  const db = cacheDatabase();
  return !!db && typeof db.open === 'function';
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

async function openCacheDatabase() {
  if (!cacheAvailable()) return null;
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = cacheDatabase().open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        const store = db.createObjectStore(SESSION_STORE, { keyPath: 'key' });
        store.createIndex('ownerAccess', ['ownerId', 'lastAccessed']);
      } else {
        // Version 1 could collapse several UI projections that shared one seq.
        // Do not hydrate already-corrupted records after the projection fix.
        request.transaction.objectStore(SESSION_STORE).clear();
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error('Failed to open history cache'));
    request.onblocked = () => reject(new Error('History cache upgrade is blocked'));
  }).catch((error) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

function isFenceCurrent(fence) {
  return !!fence
    && !!browserOwnerId
    && fence.ownerId === browserOwnerId
    && fence.epoch === browserOwnerEpoch;
}

function plainHistoryRow(row) {
  try {
    // Pinia exposes messagesMap rows as Vue proxies. IndexedDB structured clone
    // rejects proxies, while JSON projection strips runtime-only functions and
    // produces an independent snapshot for persistent storage.
    return JSON.parse(JSON.stringify(row));
  } catch {
    return null;
  }
}

function rowBytes(row) {
  try { return new TextEncoder().encode(JSON.stringify(row)).length; }
  catch { return 0; }
}

function rowCacheKey(row) {
  const explicit = row?.stableKey || row?.uiKey;
  if (explicit) return String(explicit);
  const unit = yeaftHistoryUnitKey(row);
  const projection = [
    row?.type || '',
    row?.toolName || '',
    row?.toolCallId || '',
    row?.speakerVpId || row?.vpId || '',
    row?.id || row?.messageId || '',
  ].join(':');
  return `${unit}:projection:${projection}`;
}

function chooseRows(rows, limits) {
  const units = new Map();
  for (const [index, sourceRow] of (Array.isArray(rows) ? rows : []).entries()) {
    const row = plainHistoryRow(sourceRow);
    if (!isDurableYeaftHistoryRow(row)) continue;
    const unitKey = yeaftHistoryUnitKey(row);
    const rowKey = rowCacheKey(row);
    const unit = units.get(unitKey) || {
      key: unitKey,
      seq: yeaftHistoryRowSeq(row),
      lastIndex: index,
      rowsByKey: new Map(),
    };
    unit.seq = Math.max(unit.seq ?? -1, yeaftHistoryRowSeq(row) ?? -1);
    unit.lastIndex = Math.max(unit.lastIndex, index);
    unit.rowsByKey.set(rowKey, { row, index });
    units.set(unitKey, unit);
  }
  const newest = Array.from(units.values()).map(unit => {
    const entries = Array.from(unit.rowsByKey.values());
    return {
      ...unit,
      entries,
      rowCount: entries.length,
      bytes: entries.reduce((sum, entry) => sum + rowBytes(entry.row), 0),
    };
  }).sort((left, right) => (
    (right.seq ?? -1) - (left.seq ?? -1) || right.lastIndex - left.lastIndex
  ));
  const selectedUnits = [];
  let rowCount = 0;
  let bytes = 0;
  for (const unit of newest) {
    const exceedsLimit = rowCount + unit.rowCount > limits.maxRowsPerSession
      || bytes + unit.bytes > limits.maxBytesPerSession;
    if (selectedUnits.length > 0 && exceedsLimit) break;
    selectedUnits.push(unit);
    rowCount += unit.rowCount;
    bytes += unit.bytes;
  }
  const selected = selectedUnits
    .flatMap(unit => unit.entries)
    .sort((left, right) => left.index - right.index)
    .map(entry => entry.row);
  return { rows: selected, bytes };
}

async function deleteRecordsWhere(predicate) {
  const db = await openCacheDatabase();
  // No IndexedDB means no durable browser cache exists to clean.
  if (!db) return true;
  const transaction = db.transaction(SESSION_STORE, 'readwrite');
  const store = transaction.objectStore(SESSION_STORE);
  const records = await requestPromise(store.getAll());
  for (const record of records) {
    if (predicate(record)) store.delete(record.key);
  }
  await transactionComplete(transaction);
  return true;
}

function queueOwnerCleanup(cleanup, { full = false } = {}) {
  if (full) fullCleanupRequired = true;
  const waitForPrevious = ownerCleanupPromise.catch(() => {
    if (!fullCleanupRequired) throw new Error('Browser history owner cleanup failed');
  });
  ownerCleanupPromise = waitForPrevious.then(async () => {
    const runFullCleanup = fullCleanupRequired;
    const cleaned = await (runFullCleanup ? deleteRecordsWhere(() => true) : cleanup());
    if (!cleaned) throw new Error('Browser history owner cleanup is unavailable');
    if (runFullCleanup) fullCleanupRequired = false;
    return true;
  });
  // bind callers do not await cleanup directly; keep the rejected promise as a
  // read/write fence without leaking an unhandled rejection to the browser.
  void ownerCleanupPromise.catch(() => {});
  return ownerCleanupPromise;
}

async function pruneOwnerRecords(ownerId, limits) {
  const db = await openCacheDatabase();
  if (!db) return;
  const transaction = db.transaction(SESSION_STORE, 'readwrite');
  const store = transaction.objectStore(SESSION_STORE);
  const records = (await requestPromise(store.getAll()))
    .filter(record => record?.ownerId === ownerId)
    .sort((left, right) => (Number(right.lastAccessed) || 0) - (Number(left.lastAccessed) || 0));
  const expiredBefore = Date.now() - limits.maxAgeMs;
  records.forEach((record, index) => {
    if (index >= limits.maxSessionsPerOwner || (Number(record.lastAccessed) || 0) < expiredBefore) {
      store.delete(record.key);
    }
  });
  await transactionComplete(transaction);
}

export function bindYeaftHistoryBrowserOwner(value) {
  const ownerId = normalizeId(value);
  if (!ownerId) {
    void clearYeaftHistoryBrowserOwner();
    return null;
  }
  if (browserOwnerId !== ownerId) {
    browserOwnerId = ownerId;
    browserOwnerEpoch += 1;
    // Module memory is empty after reload/new tab. Scan persistent records instead
    // of relying on previousOwnerId so another user's plaintext cannot survive.
    queueOwnerCleanup(() => deleteRecordsWhere(record => record?.ownerId !== ownerId));
  }
  return currentYeaftHistoryBrowserFence();
}

export function clearYeaftHistoryBrowserOwner() {
  browserOwnerId = null;
  browserOwnerEpoch += 1;
  // Clear all records, including the reload case where the in-memory owner is
  // unknown. Callers may await the returned promise for physical deletion.
  return queueOwnerCleanup(() => deleteRecordsWhere(() => true), { full: true });
}

export function currentYeaftHistoryBrowserFence() {
  return browserOwnerId ? { ownerId: browserOwnerId, epoch: browserOwnerEpoch } : null;
}

export async function readYeaftHistoryBrowserCache({
  fence,
  agentId,
  sessionId,
  limits = YEAFT_HISTORY_BROWSER_CACHE_LIMITS,
} = {}) {
  const normalizedAgentId = normalizeId(agentId);
  const normalizedSessionId = normalizeId(sessionId);
  if (!isFenceCurrent(fence) || !normalizedAgentId || !normalizedSessionId) return null;
  try {
    await ownerCleanupPromise;
    const db = await openCacheDatabase();
    if (!db || !isFenceCurrent(fence)) return null;
    const key = identityKey(fence.ownerId, normalizedAgentId, normalizedSessionId);
    const transaction = db.transaction(SESSION_STORE, 'readwrite');
    const store = transaction.objectStore(SESSION_STORE);
    const record = await requestPromise(store.get(key));
    const expiredBefore = Date.now() - limits.maxAgeMs;
    const expired = !!record && (Number(record.lastAccessed) || 0) < expiredBefore;
    if (expired) store.delete(key);
    await transactionComplete(transaction);
    if (expired || !isFenceCurrent(fence) || record?.schemaVersion !== CACHE_SCHEMA_VERSION
        || record.ownerId !== fence.ownerId || record.agentId !== normalizedAgentId
        || record.sessionId !== normalizedSessionId || !Array.isArray(record.rows)) return null;
    return record;
  } catch {
    return null;
  }
}

export async function writeYeaftHistoryBrowserCache({
  fence,
  agentId,
  sessionId,
  rows,
  historyState = null,
  limits = YEAFT_HISTORY_BROWSER_CACHE_LIMITS,
} = {}) {
  const normalizedAgentId = normalizeId(agentId);
  const normalizedSessionId = normalizeId(sessionId);
  if (!isFenceCurrent(fence) || !normalizedAgentId || !normalizedSessionId) return false;
  const selected = chooseRows(rows, limits);
  if (selected.rows.length === 0) return false;
  try {
    await ownerCleanupPromise;
    const db = await openCacheDatabase();
    if (!db || !isFenceCurrent(fence)) return false;
    const now = Date.now();
    const transaction = db.transaction(SESSION_STORE, 'readwrite');
    transaction.objectStore(SESSION_STORE).put({
      key: identityKey(fence.ownerId, normalizedAgentId, normalizedSessionId),
      schemaVersion: CACHE_SCHEMA_VERSION,
      ownerId: fence.ownerId,
      agentId: normalizedAgentId,
      sessionId: normalizedSessionId,
      rows: selected.rows,
      rowCount: selected.rows.length,
      byteCount: selected.bytes,
      latestSeq: Number.isFinite(historyState?.latestSeq) ? historyState.latestSeq : null,
      oldestSeq: Number.isFinite(historyState?.oldestSeq) ? historyState.oldestSeq : null,
      hasMore: !!historyState?.hasMore,
      lastAccessed: now,
    });
    await transactionComplete(transaction);
    if (!isFenceCurrent(fence)) return false;
    void pruneOwnerRecords(fence.ownerId, limits).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function removeYeaftHistoryBrowserCache({ fence, agentId, sessionId } = {}) {
  const normalizedAgentId = normalizeId(agentId);
  const normalizedSessionId = normalizeId(sessionId);
  if (!isFenceCurrent(fence) || !normalizedAgentId || !normalizedSessionId) return false;
  await ownerCleanupPromise;
  const db = await openCacheDatabase();
  if (!db || !isFenceCurrent(fence)) return false;
  const transaction = db.transaction(SESSION_STORE, 'readwrite');
  transaction.objectStore(SESSION_STORE).delete(
    identityKey(fence.ownerId, normalizedAgentId, normalizedSessionId),
  );
  await transactionComplete(transaction);
  return isFenceCurrent(fence);
}
