const DETAIL_SUMMARY_FIELDS = Object.freeze([
  'revision',
  'title',
  'goal',
  'workItemType',
  'planningMode',
  'status',
  'currentActionId',
  'currentAction',
  'executionStats',
  'failureReason',
  'origin',
  'linkedSessionIds',
  'createdAt',
  'updatedAt',
]);

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function isWorkItemSummaryStale(summary, current) {
  if (!summary || !current || summary.id !== current.id) return false;
  const summaryRevision = numberOrNull(summary.revision);
  const currentRevision = numberOrNull(current.revision);
  if (summaryRevision != null && currentRevision != null && summaryRevision !== currentRevision) {
    return summaryRevision < currentRevision;
  }
  const summaryUpdatedAt = numberOrNull(summary.updatedAt);
  const currentUpdatedAt = numberOrNull(current.updatedAt);
  return summaryUpdatedAt != null && currentUpdatedAt != null && summaryUpdatedAt < currentUpdatedAt;
}

function isActionProgressStale(currentStats, nextStats) {
  const currentProgress = numberOrNull(currentStats?.progressRevision);
  const nextProgress = numberOrNull(nextStats?.progressRevision);
  return currentProgress != null && nextProgress != null && nextProgress < currentProgress;
}

export function workItemDetailNeedsRefresh(current, summary) {
  if (!current || current.id !== summary?.id || !summary.currentActionId) return false;
  return !Array.isArray(current.actions)
    || !current.actions.some(action => action?.id === summary.currentActionId);
}

const PROGRESS_BOUND_SUMMARY_FIELDS = new Set([
  'status',
  'currentActionId',
  'currentAction',
  'executionStats',
  'failureReason',
]);

export function mergeWorkItemSummary(current, summary) {
  if (!current || current.id !== summary?.id || isWorkItemSummaryStale(summary, current)) return current;
  const merged = { ...current };
  let aggregateAccepted = !Array.isArray(current.actions) || !Array.isArray(summary.actionStats);
  if (Array.isArray(current.actions) && Array.isArray(summary.actionStats)) {
    const statsById = new Map(summary.actionStats.map(stats => [stats?.id, stats]));
    let matchedStats = false;
    aggregateAccepted = true;
    merged.actions = current.actions.map(action => {
      const stats = statsById.get(action?.id);
      if (!stats) return action;
      matchedStats = true;
      const nextProgress = numberOrNull(stats?.progressRevision);
      if (nextProgress == null) {
        const { response, messages, ...legacyStats } = stats;
        return { ...action, ...legacyStats };
      }
      if (isActionProgressStale(action, stats)) {
        aggregateAccepted = false;
        return action;
      }
      return { ...action, ...stats };
    });
    if (!matchedStats) aggregateAccepted = false;
  }
  for (const field of DETAIL_SUMMARY_FIELDS) {
    if (!aggregateAccepted && PROGRESS_BOUND_SUMMARY_FIELDS.has(field)) continue;
    if (Object.prototype.hasOwnProperty.call(summary, field)) merged[field] = summary[field];
  }
  return merged;
}

function hasStaleActionProgress(currentStats, nextStats) {
  if (!Array.isArray(currentStats) || !Array.isArray(nextStats)) return false;
  const currentById = new Map(currentStats.map(stats => [stats?.id, stats]));
  return nextStats.some(stats => {
    const current = currentById.get(stats?.id);
    return current ? isActionProgressStale(current, stats) : false;
  });
}

function isSameWorkItemVersion(current, summary) {
  return numberOrNull(current?.revision) === numberOrNull(summary?.revision)
    && numberOrNull(current?.updatedAt) === numberOrNull(summary?.updatedAt);
}

export function isWorkItemDetailStale(detail, current) {
  if (!detail || !current || detail.id !== current.id) return false;
  if (isWorkItemSummaryStale(detail, current)) return true;
  return isSameWorkItemVersion(current, detail)
    && hasStaleActionProgress(current.actions, detail.actions);
}

export function applyWorkItemSummary(items, summary) {
  const current = Array.isArray(items) ? items : [];
  const existing = current.find(item => item.id === summary?.id) || null;
  let nextSummary = existing && isWorkItemSummaryStale(summary, existing) ? existing : summary;
  if (existing && nextSummary === summary && isSameWorkItemVersion(existing, summary)
    && hasStaleActionProgress(existing.actionStats, summary.actionStats)) {
    nextSummary = {
      ...summary,
      status: existing.status,
      currentActionId: existing.currentActionId,
      currentAction: existing.currentAction,
      executionStats: existing.executionStats,
      failureReason: existing.failureReason,
      actionStats: existing.actionStats,
    };
  }
  if (!nextSummary?.id) return current;
  return [nextSummary, ...current.filter(item => item.id !== nextSummary.id)]
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
