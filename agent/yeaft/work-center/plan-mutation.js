import { actionForStage, applyGeneratedPlan } from './workflow.js';

function cleanProposalId(value) {
  const id = typeof value === 'string' ? value.trim().slice(0, 128) : '';
  if (!id) throw new Error('Work Center plan proposal requires proposalId');
  return id;
}

function validateDependencyPatches(actions, patches, addedIds) {
  const active = new Map(actions
    .filter(action => !['superseded', 'cancelled'].includes(action.status))
    .map(action => [action.stageId, action]));
  const normalized = [];
  for (const raw of Array.isArray(patches) ? patches : []) {
    const actionId = typeof raw?.actionId === 'string' ? raw.actionId.trim() : '';
    const action = actions.find(candidate => candidate.id === actionId);
    if (!action || action.status !== 'ready' || action.attempt !== 0) {
      throw new Error(`Work Center dependency patch target must be an unattempted ready Action: ${actionId || '(missing)'}`);
    }
    const addDependsOnActionIds = [...new Set((raw.addDependsOnActionIds || [])
      .map(id => String(id || '').trim()).filter(Boolean))];
    if (addDependsOnActionIds.length === 0) throw new Error('Work Center dependency patch must add at least one dependency');
    for (const dependencyId of addDependsOnActionIds) {
      if (!active.has(dependencyId) && !addedIds.has(dependencyId)) {
        throw new Error(`Work Center dependency patch references missing Action: ${dependencyId}`);
      }
      if (dependencyId === action.stageId) throw new Error('Work Center Action cannot depend on itself');
    }
    normalized.push({ action, addDependsOnActionIds });
  }
  return normalized;
}

export function applyAdditivePlanProposal({ workItem, actions, proposal, availableVpIds = null }) {
  if (workItem.workflowSnapshot?.executionMode !== 'graph') {
    throw new Error('Work Center additive planning requires graph execution');
  }
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new Error('Work Center plan proposal must be an object');
  }
  const proposalId = cleanProposalId(proposal.proposalId);
  const basePlanRevision = Number(proposal.basePlanRevision);
  if (!Number.isInteger(basePlanRevision) || basePlanRevision !== workItem.planRevision) {
    throw new Error('Work Center plan proposal has a stale basePlanRevision');
  }
  if (!Array.isArray(proposal.actions) || proposal.actions.length < 1 || proposal.actions.length > 8) {
    throw new Error('Work Center additive plan requires between 1 and 8 new Actions');
  }
  const activeStages = workItem.workflowSnapshot.stages || [];
  const existingIds = new Set(activeStages.map(stage => stage.id));
  const addedIds = new Set();
  for (const raw of proposal.actions) {
    const id = typeof raw?.id === 'string' ? raw.id.trim().toLowerCase() : '';
    if (!id || existingIds.has(id) || addedIds.has(id)) {
      throw new Error(`Work Center additive Action id is missing or already exists: ${id || '(missing)'}`);
    }
    addedIds.add(id);
  }
  const dependencyPatches = validateDependencyPatches(actions, proposal.dependencyPatches, addedIds);
  const synthetic = {
    ...workItem,
    workflowSnapshot: {
      ...workItem.workflowSnapshot,
      actionTemplates: [],
      workItemType: workItem.workflowSnapshot.workItemType,
      stages: [workItem.workflowSnapshot.stages[0]],
    },
  };
  const rawPlan = {
    workItemType: workItem.workflowSnapshot.workItemType,
    actions: [
      ...activeStages.slice(1)
        .filter(stage => !dependencyPatches.some(patch => patch.action.stageId === stage.id))
        .map(stage => ({
          id: stage.id, name: stage.name, type: stage.type,
          objective: stage.objective, approach: stage.approach, expectedOutcome: stage.expectedOutcome,
          capability: stage.assignmentPolicy?.capability,
          candidateVpIds: stage.assignmentPolicy?.mode === 'planned' ? stage.assignmentPolicy.candidateVpIds : undefined,
          assignmentReason: stage.assignmentPolicy?.assignmentReason,
          separateFromActionTypes: stage.assignmentPolicy?.separateFromStageTypes,
          dependsOnActionIds: stage.dependsOnStageIds || [],
          workspaceMode: stage.workspaceMode,
          changesRequestedActionId: stage.changesRequestedStageId,
          maxAttempts: stage.maxAttempts,
        })),
      ...proposal.actions,
      ...activeStages.slice(1)
        .filter(stage => dependencyPatches.some(patch => patch.action.stageId === stage.id))
        .map(stage => ({
          id: stage.id, name: stage.name, type: stage.type,
          objective: stage.objective, approach: stage.approach, expectedOutcome: stage.expectedOutcome,
          capability: stage.assignmentPolicy?.capability,
          candidateVpIds: stage.assignmentPolicy?.mode === 'planned' ? stage.assignmentPolicy.candidateVpIds : undefined,
          assignmentReason: stage.assignmentPolicy?.assignmentReason,
          separateFromActionTypes: stage.assignmentPolicy?.separateFromStageTypes,
          dependsOnActionIds: [
            ...(stage.dependsOnStageIds || []),
            ...(dependencyPatches.find(patch => patch.action.stageId === stage.id)?.addDependsOnActionIds || []),
          ],
          workspaceMode: stage.workspaceMode,
          changesRequestedActionId: stage.changesRequestedStageId,
          maxAttempts: stage.maxAttempts,
        })),
    ],
  };
  const workflowSnapshot = applyGeneratedPlan(synthetic, rawPlan, { availableVpIds });
  const addedStages = workflowSnapshot.stages.filter(stage => addedIds.has(stage.id));
  return {
    proposalId,
    basePlanRevision,
    workflowSnapshot,
    nextActions: addedStages.map(stage => actionForStage(stage, { ...workItem, workflowSnapshot }, [])),
    dependencyPatches,
  };
}
