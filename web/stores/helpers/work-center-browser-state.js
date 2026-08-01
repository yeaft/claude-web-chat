const DRAFT_STORAGE_KEY = 'yeaft-work-center-composer-drafts-v1';
const OUTBOX_STORAGE_KEY = 'yeaft-work-center-message-outbox-v1';

let ownerId = null;
let epoch = 0;
const listeners = new Set();

function storage() {
  return globalThis.localStorage || null;
}

function notify() {
  const state = currentWorkCenterBrowserOwner();
  for (const listener of listeners) {
    try { listener(state); } catch {}
  }
}

function removePersistentState() {
  try {
    storage()?.removeItem(DRAFT_STORAGE_KEY);
    storage()?.removeItem(OUTBOX_STORAGE_KEY);
  } catch {}
}

function normalizeOwnerId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function parseOwnedRecord(key, fence) {
  if (!isWorkCenterBrowserFenceCurrent(fence)) return {};
  try {
    const parsed = JSON.parse(storage()?.getItem(key) || 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || parsed.ownerId !== fence.ownerId
        || !parsed.records || typeof parsed.records !== 'object'
        || Array.isArray(parsed.records)) {
      storage()?.removeItem(key);
      return {};
    }
    return parsed.records;
  } catch {
    try { storage()?.removeItem(key); } catch {}
    return {};
  }
}

function writeOwnedRecord(key, records, fence) {
  if (!isWorkCenterBrowserFenceCurrent(fence)) return false;
  try {
    storage()?.setItem(key, JSON.stringify({ ownerId: fence.ownerId, records: records || {} }));
    return true;
  } catch {
    return false;
  }
}

export function bindWorkCenterBrowserOwner(value) {
  const nextOwnerId = normalizeOwnerId(value);
  if (!nextOwnerId) {
    clearWorkCenterBrowserOwner();
    return null;
  }
  if (ownerId !== nextOwnerId) {
    ownerId = nextOwnerId;
    epoch += 1;
    for (const key of [DRAFT_STORAGE_KEY, OUTBOX_STORAGE_KEY]) {
      try {
        const parsed = JSON.parse(storage()?.getItem(key) || 'null');
        if (!parsed || parsed.ownerId !== nextOwnerId) storage()?.removeItem(key);
      } catch {
        try { storage()?.removeItem(key); } catch {}
      }
    }
    notify();
  }
  return currentWorkCenterBrowserOwner();
}

export function clearWorkCenterBrowserOwner() {
  ownerId = null;
  epoch += 1;
  removePersistentState();
  notify();
}

export function currentWorkCenterBrowserOwner() {
  return ownerId ? { ownerId, epoch } : null;
}

export function isWorkCenterBrowserFenceCurrent(fence) {
  return !!fence && !!ownerId && fence.ownerId === ownerId && fence.epoch === epoch;
}

export function readWorkCenterBrowserState(fence) {
  return {
    drafts: parseOwnedRecord(DRAFT_STORAGE_KEY, fence),
    outbox: parseOwnedRecord(OUTBOX_STORAGE_KEY, fence),
  };
}

export function writeWorkCenterDrafts(records, fence) {
  return writeOwnedRecord(DRAFT_STORAGE_KEY, records, fence);
}

export function writeWorkCenterOutbox(records, fence) {
  return writeOwnedRecord(OUTBOX_STORAGE_KEY, records, fence);
}

export function subscribeWorkCenterBrowserOwner(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const WORK_CENTER_BROWSER_STORAGE_KEYS = Object.freeze({
  drafts: DRAFT_STORAGE_KEY,
  outbox: OUTBOX_STORAGE_KEY,
});
