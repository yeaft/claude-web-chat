import { yeaftHistoryIdentityKey } from './yeaft-history-identity.js';

export const YEAFT_HISTORY_LOAD_TIMEOUT_MS = 15_000;

function normalizeRequestId(value) {
  return typeof value === 'string' && value ? value : null;
}

function loadState(store, sessionKey) {
  return store?.yeaftSessionHistoryState?.[sessionKey] || null;
}

export function activeYeaftHistoryIdentity(store) {
  let sessionId = store?.yeaftActiveSessionFilter || null;
  if (!sessionId) {
    try {
      const sessions = typeof window !== 'undefined' && window.Pinia?.useSessionsStore?.();
      sessionId = sessions?.activeSessionId || null;
    } catch (_) {}
  }
  if (!sessionId) return { agentId: store?.currentAgent || null, sessionId: null, sessionKey: '' };
  const agentId = typeof store?.resolveYeaftSessionAgentId === 'function'
    ? store.resolveYeaftSessionAgentId(sessionId)
    : store?.currentAgent || null;
  return {
    agentId,
    sessionId,
    sessionKey: yeaftHistoryIdentityKey(agentId, sessionId),
  };
}

export function beginYeaftHistoryLoad(store, {
  agentId,
  sessionId,
  mode = 'recent',
  preserveLoaded = false,
  latestSeq = null,
} = {}) {
  if (!agentId || !sessionId) return null;
  const sessionKey = yeaftHistoryIdentityKey(agentId, sessionId);
  const previous = loadState(store, sessionKey) || {};
  const generation = Number(previous.generation || 0) + 1;
  const requestId = `yeaft_history_${generation}_${crypto.randomUUID()}`;
  const next = {
    ...previous,
    // Refreshes are stale-while-revalidate. Once a Session has a committed
    // history window, starting a recent replay must not make that window look
    // unloaded or clear its pagination metadata before the replacement lands.
    // A first-ever load still starts with loaded=false because `previous` is
    // empty. `preserveLoaded` remains relevant for delta/older callers that may
    // begin from a partially initialized state.
    loaded: !!previous.loaded,
    loading: true,
    error: null,
    requestId,
    generation,
    mode,
    requestedAt: Date.now(),
    latestSeq: Number.isFinite(latestSeq) ? latestSeq : (previous.latestSeq ?? null),
  };
  if (!preserveLoaded) {
    // A recent replay supersedes any delta request. Keep committed pagination,
    // but always retire the delta in-flight fence so a failed/empty replay
    // cannot permanently block the next catch-up.
    next.syncingAfterSeq = null;
    if (!previous.loaded) {
      next.hasMore = false;
      next.oldestSeq = null;
      next.count = 0;
    }
  }
  store.yeaftSessionHistoryState = {
    ...(store.yeaftSessionHistoryState || {}),
    [sessionKey]: next,
  };
  syncActiveYeaftHistoryLoad(store);
  return { sessionKey, requestId, generation, state: next };
}

export function isCurrentYeaftHistoryResponse(store, msg = {}) {
  const sessionId = msg.sessionId ?? msg.groupId ?? null;
  if (!sessionId) return false;
  const agentId = msg.agentId || store?.yeaftSessionAgentById?.[sessionId] || null;
  const sessionKey = yeaftHistoryIdentityKey(agentId, sessionId);
  const state = loadState(store, sessionKey);
  const responseRequestId = normalizeRequestId(msg.requestId);
  if (!state) return responseRequestId === null;
  const pendingRequestId = normalizeRequestId(state.requestId);
  if (responseRequestId) return responseRequestId === pendingRequestId;
  return pendingRequestId === null;
}

export function finishYeaftHistoryLoad(store, msg = {}, patch = {}) {
  if (!isCurrentYeaftHistoryResponse(store, msg)) return null;
  const sessionId = msg.sessionId ?? msg.groupId ?? null;
  const agentId = msg.agentId || store?.yeaftSessionAgentById?.[sessionId] || null;
  const sessionKey = yeaftHistoryIdentityKey(agentId, sessionId);
  const previous = loadState(store, sessionKey) || {};
  const next = {
    ...previous,
    ...patch,
    loading: false,
    error: null,
    requestId: null,
    completedAt: Date.now(),
  };
  store.yeaftSessionHistoryState = {
    ...(store.yeaftSessionHistoryState || {}),
    [sessionKey]: next,
  };
  syncActiveYeaftHistoryLoad(store);
  return next;
}

export function failYeaftHistoryLoad(store, { agentId, sessionId, requestId, error = 'history_load_failed' } = {}) {
  if (!agentId || !sessionId || !requestId) return false;
  const sessionKey = yeaftHistoryIdentityKey(agentId, sessionId);
  const previous = loadState(store, sessionKey);
  if (!previous || previous.requestId !== requestId || !previous.loading) return false;
  store.yeaftSessionHistoryState = {
    ...(store.yeaftSessionHistoryState || {}),
    [sessionKey]: {
      ...previous,
      loading: false,
      error,
      requestId: null,
      completedAt: Date.now(),
    },
  };
  syncActiveYeaftHistoryLoad(store);
  return true;
}

export function syncActiveYeaftHistoryLoad(store) {
  const { sessionKey } = activeYeaftHistoryIdentity(store);
  const state = sessionKey ? loadState(store, sessionKey) : null;
  store.yeaftLoadingMoreHistory = !!state?.loading;
  store.yeaftHistoryLoadError = state?.error || null;
  store.yeaftHasMoreHistory = !!state?.hasMore;
  store.yeaftOldestLoadedSeq = Number.isFinite(state?.oldestSeq) ? state.oldestSeq : null;
  return state;
}

export function activeYeaftHistoryLoadState(store) {
  const { sessionKey } = activeYeaftHistoryIdentity(store);
  return sessionKey ? loadState(store, sessionKey) : null;
}
