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
      const currentProgress = numberOrNull(action?.progressRevision) ?? 0;
      const nextProgress = numberOrNull(stats?.progressRevision);
      if (nextProgress == null) {
        const { response, ...legacyStats } = stats;
        return { ...action, ...legacyStats };
      }
      if (nextProgress < currentProgress) {
        aggregateAccepted = false;
        return action;
      }
      return { ...action, ...stats };
    });
    if (!matchedStats) aggregateAccepted = false;
  }
  for (const field of DETAIL_SUMMARY_FIELDS) {
    if (field === 'executionStats' && !aggregateAccepted) continue;
    if (Object.prototype.hasOwnProperty.call(summary, field)) merged[field] = summary[field];
  }
  return merged;
}

export function applyWorkItemSummary(items, summary) {
  const current = Array.isArray(items) ? items : [];
  const existing = current.find(item => item.id === summary?.id) || null;
  const nextSummary = existing && isWorkItemSummaryStale(summary, existing) ? existing : summary;
  if (!nextSummary?.id) return current;
  return [nextSummary, ...current.filter(item => item.id !== nextSummary.id)]
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}
