import {
  isDurableYeaftHistoryRow,
  yeaftHistoryRowSeq,
} from './yeaft-history-cache.js';

const DATABASE_NAME = 'yeaft-history-cache';
const DATABASE_VERSION = 1;
const SESSION_STORE = 'sessions';
const CACHE_SCHEMA_VERSION = 1;

export const YEAFT_HISTORY_BROWSER_CACHE_LIMITS = Object.freeze({
  maxSessionsPerOwner: 12,
  maxRowsPerSession: 600,
  maxBytesPerSession: 4 * 1024 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
});

let browserOwnerId = null;
let browserOwnerEpoch = 0;
let databasePromise = null;

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
      }
    };
    request.onsuccess = () => resolve(request.result);
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

function rowBytes(row) {
  try { return new TextEncoder().encode(JSON.stringify(row)).length; }
  catch { return 0; }
}

function rowCacheKey(row) {
  const seq = yeaftHistoryRowSeq(row);
  if (Number.isFinite(seq)) return `seq:${seq}`;
  return row?.stableKey || row?.uiKey || row?.messageId || row?.id || null;
}

function chooseRows(rows, limits) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isDurableYeaftHistoryRow(row)) continue;
    const key = rowCacheKey(row);
    if (!key) continue;
    byKey.set(key, row);
  }
  const newest = Array.from(byKey.values()).sort((left, right) => (
    (yeaftHistoryRowSeq(right) ?? -1) - (yeaftHistoryRowSeq(left) ?? -1)
  ));
  const selected = [];
  let bytes = 0;
  for (const row of newest) {
    const nextBytes = rowBytes(row);
    if (selected.length >= limits.maxRowsPerSession) break;
    if (selected.length > 0 && bytes + nextBytes > limits.maxBytesPerSession) break;
    selected.push(row);
    bytes += nextBytes;
  }
  selected.sort((left, right) => (
    (yeaftHistoryRowSeq(left) ?? -1) - (yeaftHistoryRowSeq(right) ?? -1)
  ));
  return { rows: selected, bytes };
}

async function deleteOwnerRecords(ownerId) {
  const db = await openCacheDatabase();
  if (!db) return false;
  const transaction = db.transaction(SESSION_STORE, 'readwrite');
  const store = transaction.objectStore(SESSION_STORE);
  const records = await requestPromise(store.getAll());
  for (const record of records) {
    if (record?.ownerId === ownerId) store.delete(record.key);
  }
  await transactionComplete(transaction);
  return true;
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
  if (browserOwnerId !== ownerId) {
    const previousOwnerId = browserOwnerId;
    browserOwnerId = ownerId;
    browserOwnerEpoch += 1;
    if (previousOwnerId) void deleteOwnerRecords(previousOwnerId).catch(() => {});
  }
  return currentYeaftHistoryBrowserFence();
}

export function clearYeaftHistoryBrowserOwner() {
  const previousOwnerId = browserOwnerId;
  browserOwnerId = null;
  browserOwnerEpoch += 1;
  if (previousOwnerId) void deleteOwnerRecords(previousOwnerId).catch(() => {});
}

export function currentYeaftHistoryBrowserFence() {
  return browserOwnerId ? { ownerId: browserOwnerId, epoch: browserOwnerEpoch } : null;
}

export async function readYeaftHistoryBrowserCache({ fence, agentId, sessionId } = {}) {
  const normalizedAgentId = normalizeId(agentId);
  const normalizedSessionId = normalizeId(sessionId);
  if (!isFenceCurrent(fence) || !normalizedAgentId || !normalizedSessionId) return null;
  try {
    const db = await openCacheDatabase();
    if (!db || !isFenceCurrent(fence)) return null;
    const transaction = db.transaction(SESSION_STORE, 'readonly');
    const record = await requestPromise(transaction.objectStore(SESSION_STORE).get(
      identityKey(fence.ownerId, normalizedAgentId, normalizedSessionId),
    ));
    await transactionComplete(transaction);
    if (!isFenceCurrent(fence) || record?.schemaVersion !== CACHE_SCHEMA_VERSION
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
  try {
    const db = await openCacheDatabase();
    if (!db || !isFenceCurrent(fence)) return false;
    const transaction = db.transaction(SESSION_STORE, 'readwrite');
    transaction.objectStore(SESSION_STORE).delete(
      identityKey(fence.ownerId, normalizedAgentId, normalizedSessionId),
    );
    await transactionComplete(transaction);
    return isFenceCurrent(fence);
  } catch {
    return false;
  }
}
