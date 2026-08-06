import { yeaftHistoryIdentityKey } from './yeaft-history-identity.js';

export const YEAFT_HISTORY_CACHE_LIMITS = Object.freeze({
  maxSessions: 8,
  maxRowsPerSession: 600,
  maxBytesPerSession: 4 * 1024 * 1024,
  maxRowsTotal: 2400,
  maxBytesTotal: 16 * 1024 * 1024,
  recentRowsFloor: 100,
});

function rowSessionId(row) {
  // `groupId` is a legacy hydrated-row alias retained during rolling upgrades.
  return row?.sessionId ?? row?.groupId ?? null;
}

function persistedMessageId(row) {
  for (const value of [row?.persistedMessageId, row?.messageId, row?.id]) {
    if (typeof value !== 'string') continue;
    const match = value.match(/^(m\d+)/);
    if (match) return match[1];
  }
  return null;
}

export function isDurableYeaftHistoryRow(row) {
  if (row?.isStreaming || row?.status === 'pending') return false;
  return Number.isFinite(row?.seq) || !!persistedMessageId(row)
    || (row?.isHistory === true && !row?.clientMessageId);
}

export function yeaftHistoryRowSeq(row) {
  if (Number.isFinite(row?.seq)) return Number(row.seq);
  const id = persistedMessageId(row);
  const match = id?.match(/^m(\d+)$/);
  if (match) return Number(match[1]);
  const leading = typeof row?.id === 'string' ? row.id.match(/^(\d+)/) : null;
  return leading ? Number(leading[1]) : null;
}

function rowBytes(row) {
  try { return new TextEncoder().encode(JSON.stringify(row)).length; }
  catch { return 0; }
}

function isUnsafeResidentRow(row) {
  if (!row) return false;
  if (row.isStreaming || row.status === 'pending') return true;
  if (row.type === 'tool-use' && (row.askPending || (!row.hasResult
    && (row.toolName === 'AskUser' || row.toolName === 'AskUserQuestion')))) return true;
  if (row.type !== 'user' || !row.clientMessageId) return false;
  return !row.dbMessageId && !persistedMessageId(row);
}

function residentTurns(rows) {
  const turns = [];
  let current = null;
  for (const row of rows) {
    if (row?.type === 'user' || !current) {
      current = { rows: [], bytes: 0, protected: false };
      turns.push(current);
    }
    current.rows.push(row);
    current.bytes += rowBytes(row);
    if (isUnsafeResidentRow(row)) current.protected = true;
  }
  return turns;
}

/**
 * Bound all resident rows for one Session (or one Chat conversation when
 * sessionId is null). Unlike durable history pruning, this also covers live
 * assistant/tool projections that have no standalone persisted message id.
 * Whole user turns are retained so eviction never leaves an orphan response.
 */
export function pruneConversationMessageRetention(store, {
  conversationId,
  agentId = null,
  sessionId = null,
  limits = YEAFT_HISTORY_CACHE_LIMITS,
} = {}) {
  const allRows = store?.messagesMap?.[conversationId];
  if (!Array.isArray(allRows) || allRows.length === 0 || !agentId || !sessionId) {
    return { evictedRows: 0, keptRows: 0 };
  }
  const matchesScope = row => rowSessionId(row) === sessionId;
  const scopedRows = allRows.filter(matchesScope);
  const turns = residentTurns(scopedRows);
  if (turns.length === 0) return { evictedRows: 0, keptRows: 0 };

  const selected = new Set(turns.filter(turn => turn.protected));
  let rows = turns.filter(turn => selected.has(turn)).reduce((sum, turn) => sum + turn.rows.length, 0);
  let bytes = turns.filter(turn => selected.has(turn)).reduce((sum, turn) => sum + turn.bytes, 0);
  let selectedCompletedTurn = false;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (selected.has(turn)) continue;
    const exceedsCapacity = rows + turn.rows.length > limits.maxRowsPerSession
      || bytes + turn.bytes > limits.maxBytesPerSession;
    const belowFloor = rows < limits.recentRowsFloor;
    if (selectedCompletedTurn && exceedsCapacity && !belowFloor) continue;
    selected.add(turn);
    selectedCompletedTurn = true;
    rows += turn.rows.length;
    bytes += turn.bytes;
  }

  const keptRows = new Set(turns.filter(turn => selected.has(turn)).flatMap(turn => turn.rows));
  const evicted = scopedRows.filter(row => !keptRows.has(row));
  if (evicted.length === 0) return { evictedRows: 0, keptRows: keptRows.size, keptBytes: bytes };
  store.messagesMap[conversationId] = allRows.filter(row => !matchesScope(row) || keptRows.has(row));

  const key = yeaftHistoryIdentityKey(agentId, sessionId);
  const previousCache = store.yeaftHistoryCacheState?.[key] || null;
  const summary = summarizeRows(scopedRows.filter(row => keptRows.has(row)));
  const previousRanges = JSON.stringify(previousCache?.ranges || []);
  const rangeEpoch = previousRanges === JSON.stringify(summary.ranges)
    ? (Number(previousCache?.rangeEpoch) || 0)
    : (Number(previousCache?.rangeEpoch) || 0) + 1;
  store.yeaftHistoryCacheState = {
    ...(store.yeaftHistoryCacheState || {}),
    [key]: {
      ...(previousCache || {}),
      agentId,
      sessionId,
      conversationId,
      lastAccessed: Date.now(),
      rangeEpoch,
      ...summary,
    },
  };

  if (evicted.some(isDurableYeaftHistoryRow)) {
    const oldestResidentSeq = summary.ranges[0]?.startSeq ?? null;
    const previousHistory = store.yeaftSessionHistoryState?.[key] || {};
    store.yeaftSessionHistoryState = {
      ...(store.yeaftSessionHistoryState || {}),
      [key]: {
        ...previousHistory,
        serverOldestFetchedSeq: oldestResidentSeq,
        oldestSeq: oldestResidentSeq,
        serverHasMore: oldestResidentSeq !== null,
        hasMore: oldestResidentSeq !== null,
        gapTraversalInitialized: false,
        gapQueue: [],
        requestedBeforeSeqs: [],
        completedHistoryWorkKeys: [],
        pendingPageKind: null,
        pendingPageBeforeSeq: null,
        pendingGapStopAtSeq: null,
        pendingCacheEpoch: null,
        pendingHistoryWorkKey: null,
        paginationError: null,
        count: summary.rowCount,
      },
    };
  }
  return {
    evictedRows: evicted.length,
    keptRows: keptRows.size,
    keptBytes: bytes,
  };
}

export function yeaftHistoryUnitKey(row) {
  if (row?.historyEntryId) return `entry:${row.historyEntryId}`;
  const seq = yeaftHistoryRowSeq(row);
  return Number.isFinite(seq) ? `seq:${seq}` : (row?.stableKey || row?.uiKey || row?.id || row?.messageId || 'legacy');
}

function durableUnits(rows) {
  const units = new Map();
  for (const row of rows) {
    if (!isDurableYeaftHistoryRow(row)) continue;
    const key = yeaftHistoryUnitKey(row);
    const unit = units.get(key) || { key, rows: [], seq: yeaftHistoryRowSeq(row), bytes: 0, touchedAt: 0 };
    unit.rows.push(row);
    unit.bytes += rowBytes(row);
    unit.touchedAt = Math.max(unit.touchedAt, Number(row?._historyCacheTouchedAt) || 0);
    units.set(key, unit);
  }
  return Array.from(units.values());
}

function chooseDurableUnits(units, limits, pinnedKeys = new Set()) {
  const byNewest = units.slice().sort((a, b) => (b.seq || -1) - (a.seq || -1));
  const required = new Set();
  let recentRows = 0;
  let requiredBytes = 0;
  for (const unit of units) {
    if (!pinnedKeys.has(unit.key)) continue;
    required.add(unit.key);
    recentRows += unit.rows.length;
    requiredBytes += unit.bytes;
  }
  for (const unit of byNewest) {
    if (required.has(unit.key)) continue;
    if (recentRows >= limits.recentRowsFloor) break;
    const nextRows = recentRows + unit.rows.length;
    const nextBytes = requiredBytes + unit.bytes;
    if (required.size > 0
      && (nextRows > limits.maxRowsPerSession || nextBytes > limits.maxBytesPerSession)) break;
    required.add(unit.key);
    recentRows = nextRows;
    requiredBytes = nextBytes;
  }
  const preferred = units.slice().sort((a, b) => (
    b.touchedAt - a.touchedAt || (b.seq || -1) - (a.seq || -1)
  ));
  const selected = new Set(required);
  let rows = units.filter(unit => required.has(unit.key)).reduce((sum, unit) => sum + unit.rows.length, 0);
  let bytes = units.filter(unit => required.has(unit.key)).reduce((sum, unit) => sum + unit.bytes, 0);
  for (const unit of preferred) {
    if (selected.has(unit.key)) continue;
    const nextRows = rows + unit.rows.length;
    const nextBytes = bytes + unit.bytes;
    if (selected.size > 0 && (nextRows > limits.maxRowsPerSession || nextBytes > limits.maxBytesPerSession)) continue;
    selected.add(unit.key);
    rows = nextRows;
    bytes = nextBytes;
  }
  return selected;
}

function compactRanges(rows) {
  const seqs = Array.from(new Set(rows.map(yeaftHistoryRowSeq).filter(Number.isFinite))).sort((a, b) => a - b);
  const ranges = [];
  for (const seq of seqs) {
    const current = ranges.at(-1);
    if (current && seq <= current.endSeq + 1) current.endSeq = seq;
    else ranges.push({ startSeq: seq, endSeq: seq });
  }
  return ranges;
}

function summarizeRows(rows) {
  const durable = rows.filter(isDurableYeaftHistoryRow);
  return {
    rowCount: durable.length,
    byteCount: durable.reduce((sum, row) => sum + rowBytes(row), 0),
    ranges: compactRanges(durable),
  };
}

function touchIncomingRows(rows, incomingRows, now) {
  const keys = new Set((incomingRows || []).map(row => row?.stableKey).filter(Boolean));
  if (keys.size === 0) return;
  for (const row of rows) {
    if (row?.stableKey && keys.has(row.stableKey)) row._historyCacheTouchedAt = now;
  }
}

function pruneOneSession(store, { conversationId, agentId, sessionId, incomingRows, now, limits }) {
  const allRows = store.messagesMap?.[conversationId] || [];
  const scoped = allRows.filter(row => rowSessionId(row) === sessionId);
  touchIncomingRows(scoped, incomingRows, now);
  const pinnedKeys = new Set((incomingRows || [])
    .filter(row => row?.historyEntryId)
    .map(yeaftHistoryUnitKey));
  const units = durableUnits(scoped);
  const selectedUnits = chooseDurableUnits(units, limits, pinnedKeys);
  const keptScoped = scoped.filter(row => (
    !isDurableYeaftHistoryRow(row) || selectedUnits.has(yeaftHistoryUnitKey(row))
  ));
  const keptSet = new Set(keptScoped);
  store.messagesMap[conversationId] = allRows.filter(row => rowSessionId(row) !== sessionId || keptSet.has(row));
  const summary = summarizeRows(keptScoped);
  const key = yeaftHistoryIdentityKey(agentId, sessionId);
  const previous = store.yeaftHistoryCacheState?.[key] || null;
  const previousRanges = JSON.stringify(previous?.ranges || []);
  const rangeEpoch = previousRanges === JSON.stringify(summary.ranges)
    ? (Number(previous?.rangeEpoch) || 0)
    : (Number(previous?.rangeEpoch) || 0) + 1;
  store.yeaftHistoryCacheState = {
    ...(store.yeaftHistoryCacheState || {}),
    [key]: {
      agentId,
      sessionId,
      conversationId,
      lastAccessed: now,
      rangeEpoch,
      ...summary,
    },
  };
}

function removeDurableSessionRows(store, entry) {
  const rows = store.messagesMap?.[entry.conversationId] || [];
  store.messagesMap[entry.conversationId] = rows.filter(row => (
    rowSessionId(row) !== entry.sessionId || !isDurableYeaftHistoryRow(row)
  ));
}

function enforceGlobalLimits(store, activeKey, limits) {
  const state = { ...(store.yeaftHistoryCacheState || {}) };
  const entries = Object.entries(state).filter(([, entry]) => entry?.rowCount > 0);
  const totals = () => Object.values(state).reduce((sum, entry) => ({
    rows: sum.rows + (Number(entry?.rowCount) || 0),
    bytes: sum.bytes + (Number(entry?.byteCount) || 0),
    sessions: sum.sessions + ((Number(entry?.rowCount) || 0) > 0 ? 1 : 0),
  }), { rows: 0, bytes: 0, sessions: 0 });
  const candidates = entries
    .filter(([key]) => key !== activeKey)
    .sort((a, b) => (Number(a[1]?.lastAccessed) || 0) - (Number(b[1]?.lastAccessed) || 0));
  for (const [key, entry] of candidates) {
    const total = totals();
    if (total.sessions <= limits.maxSessions
      && total.rows <= limits.maxRowsTotal
      && total.bytes <= limits.maxBytesTotal) break;
    removeDurableSessionRows(store, entry);
    state[key] = { ...entry, rowCount: 0, byteCount: 0, ranges: [] };
  }
  store.yeaftHistoryCacheState = state;
}

export function touchYeaftHistoryCache(store, agentId, sessionId, now = Date.now()) {
  if (!agentId || !sessionId) return;
  const key = yeaftHistoryIdentityKey(agentId, sessionId);
  const entry = store.yeaftHistoryCacheState?.[key];
  if (!entry) return;
  store.yeaftHistoryCacheState = {
    ...(store.yeaftHistoryCacheState || {}),
    [key]: { ...entry, lastAccessed: now },
  };
}

export function pruneYeaftHistoryCache(store, {
  conversationId,
  agentId,
  sessionId,
  incomingRows = [],
  activeAgentId = null,
  activeSessionId = null,
  now = Date.now(),
  limits = YEAFT_HISTORY_CACHE_LIMITS,
} = {}) {
  if (!store || !conversationId || !agentId || !sessionId) return;
  pruneOneSession(store, { conversationId, agentId, sessionId, incomingRows, now, limits });
  const activeKey = activeAgentId && activeSessionId
    ? yeaftHistoryIdentityKey(activeAgentId, activeSessionId)
    : null;
  enforceGlobalLimits(store, activeKey, limits);
}
