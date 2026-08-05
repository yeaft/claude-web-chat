import {
  isDurableYeaftHistoryRow,
  yeaftHistoryRowSeq,
  yeaftHistoryUnitKey,
} from './yeaft-history-cache.js';

const DATABASE_NAME = 'yeaft-history-cache';
const DATABASE_VERSION = 3;
const SESSION_STORE = 'sessions';
const METADATA_STORE = 'metadata';
const ACTIVE_OWNER_KEY = 'active-owner';
const CACHE_SCHEMA_VERSION = 2;

export const YEAFT_HISTORY_BROWSER_CACHE_LIMITS = Object.freeze({
  maxSessionsPerOwner: 12,
  maxRowsPerSession: 600,
  maxBytesPerSession: 4 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
});

let browserOwnerId = null;
let browserOwnerFence = null;
let databasePromise = null;
let ownerCleanupPromise = Promise.resolve(true);
let cleanupRecoveryRequired = false;

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

function createGeneration() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
        // Older schemas had no durable owner generation. Discard their rows so
        // a stale realm cannot retain plaintext across the v3 security boundary.
        request.transaction.objectStore(SESSION_STORE).clear();
      }
      if (!db.objectStoreNames.contains(METADATA_STORE)) {
        db.createObjectStore(METADATA_STORE, { keyPath: 'key' });
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
    && fence === browserOwnerFence;
}

function persistentFenceMatches(record, fence) {
  return !!record
    && !!fence
    && record.key === ACTIVE_OWNER_KEY
    && record.ownerId === fence.ownerId
    && record.generation === fence.generation;
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

async function persistActiveOwner(fence) {
  const db = await openCacheDatabase();
  const generation = createGeneration();
  if (!db) {
    fence.generation = generation;
    return true;
  }
  const transaction = db.transaction([METADATA_STORE, SESSION_STORE], 'readwrite');
  const metadataStore = transaction.objectStore(METADATA_STORE);
  const sessionStore = transaction.objectStore(SESSION_STORE);
  const activeOwner = await requestPromise(metadataStore.get(ACTIVE_OWNER_KEY));
  const canReuse = !cleanupRecoveryRequired
    && !!fence.ownerId
    && activeOwner?.ownerId === fence.ownerId
    && typeof activeOwner?.generation === 'string';
  const nextGeneration = canReuse ? activeOwner.generation : generation;
  if (!canReuse) sessionStore.clear();
  metadataStore.put({
    key: ACTIVE_OWNER_KEY,
    ownerId: fence.ownerId,
    generation: nextGeneration,
  });
  await transactionComplete(transaction);
  fence.generation = nextGeneration;
  return true;
}

function queueOwnerTransition(fence) {
  const waitForPrevious = ownerCleanupPromise.catch(() => {
    if (!cleanupRecoveryRequired) throw new Error('Browser history owner cleanup failed');
  });
  ownerCleanupPromise = waitForPrevious
    .then(() => persistActiveOwner(fence))
    .then((result) => {
      cleanupRecoveryRequired = false;
      return result;
    }, (error) => {
      cleanupRecoveryRequired = true;
      throw error;
    });
  // bind callers do not await cleanup directly; keep the rejected promise as a
  // read/write fence without leaking an unhandled rejection to the browser.
  void ownerCleanupPromise.catch(() => {});
  return ownerCleanupPromise;
}

async function pruneOwnerRecords(fence, limits) {
  const db = await openCacheDatabase();
  if (!db) return;
  const transaction = db.transaction([METADATA_STORE, SESSION_STORE], 'readwrite');
  const activeOwner = await requestPromise(
    transaction.objectStore(METADATA_STORE).get(ACTIVE_OWNER_KEY),
  );
  const store = transaction.objectStore(SESSION_STORE);
  if (!persistentFenceMatches(activeOwner, fence)) {
    await transactionComplete(transaction);
    return;
  }
  const records = (await requestPromise(store.getAll()))
    .filter(record => record?.ownerId === fence.ownerId)
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
  if (browserOwnerId !== ownerId || cleanupRecoveryRequired) {
    browserOwnerId = ownerId;
    browserOwnerFence = { ownerId, generation: null };
    // The transaction either adopts the generation already owned by this user
    // or atomically rotates it and removes every previous owner's plaintext.
    queueOwnerTransition(browserOwnerFence);
  }
  return currentYeaftHistoryBrowserFence();
}

export function clearYeaftHistoryBrowserOwner() {
  browserOwnerId = null;
  browserOwnerFence = null;
  // Persist a generation with no owner and clear rows in the same transaction.
  // Stale tabs must fail metadata validation before they can write again.
  return queueOwnerTransition({ ownerId: null, generation: null });
}

export function currentYeaftHistoryBrowserFence() {
  return browserOwnerFence;
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
    const transaction = db.transaction([METADATA_STORE, SESSION_STORE], 'readwrite');
    const activeOwner = await requestPromise(
      transaction.objectStore(METADATA_STORE).get(ACTIVE_OWNER_KEY),
    );
    const store = transaction.objectStore(SESSION_STORE);
    if (!persistentFenceMatches(activeOwner, fence)) {
      await transactionComplete(transaction);
      return null;
    }
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
    const transaction = db.transaction([METADATA_STORE, SESSION_STORE], 'readwrite');
    const activeOwner = await requestPromise(
      transaction.objectStore(METADATA_STORE).get(ACTIVE_OWNER_KEY),
    );
    if (!persistentFenceMatches(activeOwner, fence)) {
      await transactionComplete(transaction);
      return false;
    }
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
    void pruneOwnerRecords(fence, limits).catch(() => {});
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
  // No IndexedDB means there is no durable browser cache to remove.
  if (!db) return true;
  if (!isFenceCurrent(fence)) return false;
  const transaction = db.transaction([METADATA_STORE, SESSION_STORE], 'readwrite');
  const activeOwner = await requestPromise(
    transaction.objectStore(METADATA_STORE).get(ACTIVE_OWNER_KEY),
  );
  if (!persistentFenceMatches(activeOwner, fence)) {
    // A generation change atomically clears the previous generation's rows.
    await transactionComplete(transaction);
    return true;
  }
  transaction.objectStore(SESSION_STORE).delete(
    identityKey(fence.ownerId, normalizedAgentId, normalizedSessionId),
  );
  await transactionComplete(transaction);
  return true;
}
