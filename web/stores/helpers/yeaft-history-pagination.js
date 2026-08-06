const COMPLETED_WORK_LIMIT = 256;

function finiteSeq(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function normalizeRanges(ranges) {
  return (Array.isArray(ranges) ? ranges : [])
    .map(range => ({
      startSeq: finiteSeq(range?.startSeq),
      endSeq: finiteSeq(range?.endSeq),
    }))
    .filter(range => range.startSeq !== null && range.endSeq !== null && range.startSeq <= range.endSeq)
    .sort((a, b) => a.startSeq - b.startSeq);
}

function normalizeCacheEpoch(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function workKey(work) {
  const beforeSeq = finiteSeq(work?.beforeSeq);
  if (beforeSeq === null) return null;
  if (work?.kind === 'gap') {
    const stopAtSeq = finiteSeq(work.stopAtSeq);
    if (stopAtSeq === null) return null;
    return `gap:${normalizeCacheEpoch(work.cacheEpoch)}:${stopAtSeq}:${beforeSeq}`;
  }
  return `server:${beforeSeq}`;
}

function completedWorkSet(state) {
  const completed = new Set((Array.isArray(state?.completedHistoryWorkKeys)
    ? state.completedHistoryWorkKeys
    : []).filter(value => typeof value === 'string' && value));
  // Legacy snapshots only recorded numeric server cursors.
  for (const beforeSeq of Array.isArray(state?.requestedBeforeSeqs) ? state.requestedBeforeSeqs : []) {
    if (Number.isFinite(beforeSeq)) completed.add(`server:${beforeSeq}`);
  }
  return completed;
}

function appendCompletedWork(state, work) {
  const key = workKey(work);
  if (!key) return state.completedHistoryWorkKeys || [];
  const completed = completedWorkSet(state);
  completed.add(key);
  return Array.from(completed).slice(-COMPLETED_WORK_LIMIT);
}

function appendObservedCursor(state, beforeSeq) {
  if (!Number.isFinite(beforeSeq)) return state.requestedBeforeSeqs || [];
  const cursors = new Set((Array.isArray(state?.requestedBeforeSeqs)
    ? state.requestedBeforeSeqs
    : []).filter(Number.isFinite));
  cursors.add(beforeSeq);
  return Array.from(cursors).sort((a, b) => b - a).slice(-COMPLETED_WORK_LIMIT);
}

/** Derive the missing resident intervals for the current cache generation. */
export function deriveYeaftHistoryGapQueue(ranges, state = {}, cacheEpoch = 0) {
  const normalized = normalizeRanges(ranges);
  const epoch = normalizeCacheEpoch(cacheEpoch);
  const completed = completedWorkSet(state);
  const gaps = [];
  for (let index = 1; index < normalized.length; index += 1) {
    const older = normalized[index - 1];
    const newer = normalized[index];
    if (older.endSeq + 1 >= newer.startSeq) continue;
    const gap = {
      kind: 'gap',
      beforeSeq: newer.startSeq,
      stopAtSeq: older.endSeq + 1,
      cacheEpoch: epoch,
    };
    gap.workKey = workKey(gap);
    if (!completed.has(gap.workKey)) gaps.push(gap);
  }
  return gaps.sort((a, b) => b.beforeSeq - a.beforeSeq);
}

function createGapTraversalQueue(ranges, state, cacheEpoch) {
  const gaps = deriveYeaftHistoryGapQueue(ranges, state, cacheEpoch);
  const serverFrontier = finiteSeq(state.serverOldestFetchedSeq ?? state.oldestSeq);
  const firstGap = gaps[0] || null;
  if (!firstGap || serverFrontier === null || firstGap.beforeSeq <= serverFrontier) return [];
  const traversal = {
    kind: 'gap',
    beforeSeq: firstGap.beforeSeq,
    stopAtSeq: serverFrontier,
    cacheEpoch: firstGap.cacheEpoch,
  };
  traversal.workKey = workKey(traversal);
  return completedWorkSet(state).has(traversal.workKey) ? [] : [traversal];
}

/**
 * Plan one bounded history request. The server frontier moves monotonically to
 * seq 1. Once exhausted, resident gaps become explicit refill work items whose
 * identity includes kind, bounds, and cache generation.
 */
export function planNextYeaftHistoryPage(state = {}, ranges = [], cacheEpoch = 0) {
  const epoch = normalizeCacheEpoch(cacheEpoch);
  const completed = completedWorkSet(state);
  let serverHasMore = state.serverHasMore !== false;
  const serverBeforeSeq = finiteSeq(state.serverOldestFetchedSeq ?? state.oldestSeq);
  let gapTraversalInitialized = state.gapTraversalInitialized === true;
  let gapQueue = Array.isArray(state.gapQueue) ? state.gapQueue.slice() : [];
  let request = null;
  let paginationError = null;

  if (serverHasMore && serverBeforeSeq !== null) {
    const serverWork = {
      kind: 'server',
      beforeSeq: serverBeforeSeq,
      stopAtSeq: null,
      cacheEpoch: epoch,
    };
    serverWork.workKey = workKey(serverWork);
    if (completed.has(serverWork.workKey)) {
      serverHasMore = false;
      paginationError = 'history_cursor_repeated';
    } else {
      request = serverWork;
    }
  }

  if (!request && !serverHasMore) {
    if (!gapTraversalInitialized) {
      gapQueue = createGapTraversalQueue(ranges, state, epoch);
      gapTraversalInitialized = true;
    }
    request = gapQueue[0] || null;
  }
  if (!request) {
    return {
      request: null,
      state: {
        ...state,
        serverHasMore,
        gapTraversalInitialized,
        gapQueue,
        hasMore: false,
        paginationError,
      },
    };
  }

  return {
    request,
    state: {
      ...state,
      serverHasMore,
      gapTraversalInitialized,
      gapQueue,
      pendingPageKind: request.kind,
      pendingPageBeforeSeq: request.beforeSeq,
      pendingGapStopAtSeq: request.stopAtSeq,
      pendingCacheEpoch: request.cacheEpoch,
      pendingHistoryWorkKey: request.workKey,
      hasMore: true,
      paginationError: null,
    },
  };
}

/** Commit an authoritative recent/older response into pagination metadata. */
export function commitYeaftHistoryPage(state = {}, {
  mode,
  oldestSeq,
  hasMore,
  ranges = [],
  pageKind = null,
  stopAtSeq = null,
  cacheEpoch = 0,
} = {}) {
  if (mode === 'delta') return state;

  const epoch = normalizeCacheEpoch(cacheEpoch);
  const responseOldest = finiteSeq(oldestSeq);
  const pendingBefore = finiteSeq(state.pendingPageBeforeSeq);
  const pendingKind = pageKind || state.pendingPageKind || (mode === 'older' ? 'server' : null);
  const pendingStop = finiteSeq(stopAtSeq ?? state.pendingGapStopAtSeq);
  const pendingEpoch = normalizeCacheEpoch(state.pendingCacheEpoch ?? epoch);
  const pendingWork = {
    kind: pendingKind,
    beforeSeq: pendingBefore,
    stopAtSeq: pendingStop,
    cacheEpoch: pendingEpoch,
  };
  let serverOldestFetchedSeq = finiteSeq(state.serverOldestFetchedSeq ?? state.oldestSeq);
  let serverHasMore = state.serverHasMore !== false;
  let noProgressCount = Number(state.noProgressCount) || 0;
  let paginationError = null;
  let requestedBeforeSeqs = state.requestedBeforeSeqs || [];
  let completedHistoryWorkKeys = state.completedHistoryWorkKeys || [];
  let gapTraversalInitialized = state.gapTraversalInitialized === true;
  let gapQueue = Array.isArray(state.gapQueue) ? state.gapQueue.slice() : [];

  if (mode === 'recent') {
    serverOldestFetchedSeq = responseOldest;
    serverHasMore = !!hasMore;
    noProgressCount = 0;
    requestedBeforeSeqs = [];
    completedHistoryWorkKeys = [];
    gapTraversalInitialized = false;
    gapQueue = [];
  } else if (pendingBefore === null) {
    if (responseOldest !== null) {
      serverOldestFetchedSeq = serverOldestFetchedSeq === null
        ? responseOldest
        : Math.min(serverOldestFetchedSeq, responseOldest);
    }
    serverHasMore = !!hasMore;
    noProgressCount = 0;
  } else {
    requestedBeforeSeqs = appendObservedCursor(state, pendingBefore);
    completedHistoryWorkKeys = appendCompletedWork(state, pendingWork);
    const progressed = responseOldest !== null && responseOldest < pendingBefore;
    if (pendingKind === 'server') {
      if (progressed) {
        serverOldestFetchedSeq = serverOldestFetchedSeq === null
          ? responseOldest
          : Math.min(serverOldestFetchedSeq, responseOldest);
        serverHasMore = !!hasMore;
        noProgressCount = 0;
      } else {
        serverHasMore = false;
        noProgressCount += 1;
        paginationError = 'history_cursor_no_progress';
      }
    } else if (pendingKind === 'gap') {
      const pendingKey = workKey(pendingWork);
      gapQueue = gapQueue.filter(gap => workKey(gap) !== pendingKey);
      const reachedStop = pendingStop !== null
        && responseOldest !== null
        && responseOldest <= pendingStop;
      if (progressed || reachedStop || hasMore === false) {
        noProgressCount = 0;
        if (!reachedStop && hasMore !== false && responseOldest !== null && pendingStop !== null) {
          const continuation = {
            kind: 'gap',
            beforeSeq: responseOldest,
            stopAtSeq: pendingStop,
            cacheEpoch: pendingEpoch,
          };
          continuation.workKey = workKey(continuation);
          if (!completedWorkSet({ completedHistoryWorkKeys }).has(continuation.workKey)) {
            gapQueue.unshift(continuation);
          }
        }
      } else {
        noProgressCount += 1;
        paginationError = 'history_cursor_no_progress';
      }
    }
  }

  if (mode === 'older' && !serverHasMore && !gapTraversalInitialized) {
    gapQueue = createGapTraversalQueue(ranges, {
      ...state,
      serverOldestFetchedSeq,
      completedHistoryWorkKeys,
    }, epoch);
    gapTraversalInitialized = true;
  }

  const base = {
    ...state,
    serverOldestFetchedSeq,
    serverHasMore,
    requestedBeforeSeqs,
    completedHistoryWorkKeys,
    gapTraversalInitialized,
    gapQueue,
    noProgressCount,
    oldestSeq: serverOldestFetchedSeq,
    paginationError,
  };
  delete base.pendingPageKind;
  delete base.pendingPageBeforeSeq;
  delete base.pendingGapStopAtSeq;
  delete base.pendingCacheEpoch;
  delete base.pendingHistoryWorkKey;
  return {
    ...base,
    hasMore: serverHasMore || gapQueue.length > 0,
  };
}
