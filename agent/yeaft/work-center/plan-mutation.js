import { actionForStage, applyGeneratedPlan } from './workflow.js';

function cleanProposalId(value) {
  const id = typeof value === 'string' ? value.trim().slice(0, 128) : '';
  if (!id) throw new Error('Work Center plan proposal requires proposalId');
  return id;
}

function planActionFromStage(stage) {
  return {
    id: stage.id,
    name: stage.name,
    type: stage.type,
    objective: stage.objective,
    approach: stage.approach,
    expectedOutcome: stage.expectedOutcome,
    capability: stage.assignmentPolicy?.capability,
    candidateVpIds: stage.assignmentPolicy?.mode === 'planned'
      ? stage.assignmentPolicy.candidateVpIds
      : undefined,
    assignmentReason: stage.assignmentPolicy?.assignmentReason,
    separateFromActionTypes: stage.assignmentPolicy?.separateFromStageTypes,
    dependsOnActionIds: stage.dependsOnStageIds || [],
    workspaceMode: stage.workspaceMode,
    changesRequestedActionId: stage.changesRequestedStageId,
    maxAttempts: stage.maxAttempts,
  };
}

function stableTopologicalActions(actions) {
  const byId = new Map(actions.map((action, index) => [action.id, { action, index }]));
  const incoming = new Map(actions.map(action => [action.id, 0]));
  const outgoing = new Map(actions.map(action => [action.id, []]));
  for (const action of actions) {
    const orderingDependencies = new Set([
      ...(action.dependsOnActionIds || []),
      ...(action.changesRequestedActionId ? [action.changesRequestedActionId] : []),
    ]);
    for (const dependencyId of orderingDependencies) {
      if (!byId.has(dependencyId) || dependencyId === action.id) {
        throw new Error(`Work Center additive Action "${action.id}" has an invalid dependency "${dependencyId}"`);
      }
      incoming.set(action.id, incoming.get(action.id) + 1);
      outgoing.get(dependencyId).push(action.id);
    }
  }
  const ready = actions.filter(action => incoming.get(action.id) === 0)
    .sort((left, right) => byId.get(left.id).index - byId.get(right.id).index);
  const ordered = [];
  while (ready.length > 0) {
    const action = ready.shift();
    ordered.push(action);
    for (const dependentId of outgoing.get(action.id)) {
      const count = incoming.get(dependentId) - 1;
      incoming.set(dependentId, count);
      if (count === 0) {
        ready.push(byId.get(dependentId).action);
        ready.sort((left, right) => byId.get(left.id).index - byId.get(right.id).index);
      }
    }
  }
  if (ordered.length !== actions.length) {
    throw new Error('Work Center additive plan contains a dependency cycle');
  }
  return ordered;
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
  const patchByStageId = new Map(dependencyPatches.map(patch => [patch.action.stageId, patch]));
  const mergedActions = [
    ...activeStages.slice(1).map(stage => {
      const action = planActionFromStage(stage);
      const patch = patchByStageId.get(stage.id);
      if (!patch) return action;
      return {
        ...action,
        dependsOnActionIds: [...new Set([
          ...(action.dependsOnActionIds || []),
          ...patch.addDependsOnActionIds,
        ])],
      };
    }),
    ...proposal.actions,
  ];
  const rawPlan = {
    workItemType: workItem.workflowSnapshot.workItemType,
    actions: stableTopologicalActions(mergedActions),
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
