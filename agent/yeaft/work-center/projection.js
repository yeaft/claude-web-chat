function currentAction(detail) {
  if (!detail?.currentActionId || !Array.isArray(detail.actions)) return null;
  return detail.actions.find(action => action.id === detail.currentActionId) || null;
}

function count(value) {
  return Math.max(0, Number(value) || 0);
}

function actionExecution(action, runs) {
  const matchingRuns = Array.isArray(runs)
    ? runs.filter(run => run?.actionId === action?.id)
    : [];
  if (matchingRuns.length === 0) {
    return {
      loopCount: count(action?.loopCount),
      toolCount: count(action?.toolCount),
      response: '',
      progressRevision: 0,
    };
  }
  const stats = matchingRuns.reduce((total, run) => ({
    loopCount: total.loopCount + count(run.loopCount),
    toolCount: total.toolCount + count(run.toolCount),
  }), { loopCount: 0, toolCount: 0 });
  const latest = [...matchingRuns].sort((left, right) => (
    count(right.startedAt) - count(left.startedAt)
      || count(right.progressRevision) - count(left.progressRevision)
  ))[0];
  return {
    ...stats,
    response: typeof latest?.response === 'string' ? latest.response : '',
    progressRevision: count(latest?.progressRevision),
  };
}

function projectAssignmentPolicy(policy) {
  if (!policy || typeof policy !== 'object') return null;
  return {
    mode: policy.mode || null,
    fixedVpId: policy.fixedVpId || null,
  };
}

function projectAction(action, runs) {
  if (!action) return null;
  const execution = actionExecution(action, runs);
  return {
    id: action.id,
    sequence: action.sequence,
    type: action.type,
    stageId: action.stageId || action.type,
    assignmentPolicy: projectAssignmentPolicy(action.assignmentPolicy),
    requiredRole: action.requiredRole || '',
    status: action.status,
    loopCount: execution.loopCount,
    toolCount: execution.toolCount,
    response: execution.response,
    progressRevision: execution.progressRevision,
  };
}

function projectActionStats(detail) {
  if (!Array.isArray(detail?.actions)) return [];
  return detail.actions.map(action => {
    const projected = projectAction(action, detail.runs);
    return {
      id: projected.id,
      status: projected.status,
      loopCount: projected.loopCount,
      toolCount: projected.toolCount,
      response: projected.response,
      progressRevision: projected.progressRevision,
    };
  });
}

function waitingReason(detail) {
  if (typeof detail?.waitingReason === 'string') return detail.waitingReason;
  if (detail?.status !== 'waiting' || !Array.isArray(detail.runs)) return '';
  return detail.runs.find(run => (
    run?.actionId === detail.currentActionId && typeof run.waitingReason === 'string'
  ))?.waitingReason || '';
}

/**
 * Authenticated browser detail DTO. Raw execution records stay Agent-local;
 * the browser receives only Action status/counts plus the explicit user-facing response.
 */
export function projectWorkItemDetail(detail) {
  if (!detail) return null;
  return {
    id: detail.id,
    revision: detail.revision,
    title: detail.title,
    goal: detail.goal,
    acceptanceCriteria: Array.isArray(detail.acceptanceCriteria) ? detail.acceptanceCriteria : [],
    workflowTemplate: detail.workflowTemplate,
    status: detail.status,
    currentActionId: detail.currentActionId || null,
    reuseMemory: detail.reuseMemory !== false,
    waitingReason: waitingReason(detail),
    origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
    linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    actions: Array.isArray(detail.actions)
      ? detail.actions.map(action => projectAction(action, detail.runs))
      : [],
  };
}

/**
 * Browser list projection. This deliberately excludes local filesystem paths
 * and all Run-level execution detail.
 */
export function projectWorkItemSummary(detail) {
  if (!detail) return null;
  if (!Array.isArray(detail.actions)) {
    return {
      id: detail.id,
      revision: detail.revision,
      title: detail.title,
      goal: detail.goal,
      status: detail.status,
      currentActionId: detail.currentActionId || null,
      currentAction: null,
      origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
      linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    };
  }
  const action = currentAction(detail);
  const projectedAction = action ? projectAction(action, detail.runs) : null;
  return {
    id: detail.id,
    revision: detail.revision,
    title: detail.title,
    goal: detail.goal,
    status: detail.status,
    currentActionId: detail.currentActionId || null,
    currentAction: projectedAction ? {
      id: projectedAction.id,
      type: projectedAction.type,
      stageId: projectedAction.stageId,
      assignmentMode: projectedAction.assignmentPolicy?.mode || (projectedAction.requiredRole ? 'fixed' : null),
      status: projectedAction.status,
    } : null,
    origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
    linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

export function projectWorkCenterEvent(event) {
  return {
    type: event?.type || 'work_item.updated',
    workItem: {
      ...projectWorkItemSummary(event?.workItem),
      actionStats: projectActionStats(event?.workItem),
    },
  };
}
