function currentAction(detail) {
  if (!detail?.currentActionId || !Array.isArray(detail.actions)) return null;
  return detail.actions.find(action => action.id === detail.currentActionId) || null;
}

/**
 * Browser event projection. This deliberately excludes local filesystem paths,
 * Run evidence/tool output, prompts, model snapshots, and execution errors.
 * Clients fetch the selected detail explicitly through the authenticated get op.
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
