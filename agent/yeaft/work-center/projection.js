function currentAction(detail) {
  if (!detail?.currentActionId || !Array.isArray(detail.actions)) return null;
  return detail.actions.find(action => action.id === detail.currentActionId) || null;
}

function projectAction(action) {
  if (!action) return null;
  return {
    id: action.id,
    workItemId: action.workItemId,
    sequence: action.sequence,
    type: action.type,
    stageId: action.stageId || action.type,
    assignmentPolicy: action.assignmentPolicy || null,
    modelPolicy: action.modelPolicy || null,
    requiredRole: action.requiredRole || '',
    status: action.status,
    attempt: action.attempt,
    maxAttempts: action.maxAttempts,
    currentRunId: action.currentRunId || null,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function projectRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    actionId: run.actionId,
    workItemId: run.workItemId,
    status: run.status,
    startedAt: run.startedAt,
    expiresAt: run.expiresAt,
    endedAt: run.endedAt || null,
    summary: run.summary || '',
    evidence: Array.isArray(run.evidence) ? run.evidence : [],
    waitingReason: run.waitingReason || '',
    error: run.error || '',
    reviewDecision: run.reviewDecision || null,
    roleSnapshot: run.roleSnapshot ? {
      id: run.roleSnapshot.id,
      actionType: run.roleSnapshot.actionType,
      selectionReason: run.roleSnapshot.selectionReason,
    } : null,
    vpSnapshot: run.vpSnapshot ? {
      id: run.vpSnapshot.id,
      name: run.vpSnapshot.name || run.vpSnapshot.id,
      nameZh: run.vpSnapshot.nameZh || '',
      role: run.vpSnapshot.role || '',
      roleZh: run.vpSnapshot.roleZh || '',
    } : null,
    modelSnapshot: run.modelSnapshot ? {
      id: run.modelSnapshot.id,
      provider: run.modelSnapshot.provider || null,
      effort: run.modelSnapshot.effort || null,
      source: run.modelSnapshot.source || null,
    } : null,
  };
}

function projectEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    workItemId: event.workItemId,
    actionId: event.actionId || null,
    runId: event.runId || null,
    type: event.type,
    createdAt: event.createdAt,
  };
}

/**
 * Authenticated browser detail DTO. Execution-only snapshots, VP persona,
 * tool policy, prompts, event data, and local filesystem paths never cross the wire.
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
    currentRunId: detail.currentRunId || null,
    reuseMemory: detail.reuseMemory !== false,
    origin: detail.origin?.sessionId ? { sessionId: detail.origin.sessionId } : null,
    linkedSessionIds: Array.isArray(detail.linkedSessionIds) ? detail.linkedSessionIds : [],
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    actions: Array.isArray(detail.actions) ? detail.actions.map(projectAction) : [],
    runs: Array.isArray(detail.runs) ? detail.runs.map(projectRun) : [],
    events: Array.isArray(detail.events) ? detail.events.map(projectEvent) : [],
  };
}

/**
 * Browser event projection. This deliberately excludes local filesystem paths,
 * Run evidence/tool output, prompts, model snapshots, and execution errors.
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
  return {
    id: detail.id,
    revision: detail.revision,
    title: detail.title,
    goal: detail.goal,
    status: detail.status,
    currentActionId: detail.currentActionId || null,
    currentAction: action ? {
      id: action.id,
      type: action.type,
      stageId: action.stageId || action.type,
      assignmentMode: action.assignmentPolicy?.mode || (action.requiredRole ? 'fixed' : null),
      status: action.status,
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
    workItem: projectWorkItemSummary(event?.workItem),
  };
}
