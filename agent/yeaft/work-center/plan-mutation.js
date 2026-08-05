import {
  actionForStage,
  applyGeneratedPlan,
  canonicalActionId,
  canonicalExplicitActionId,
  canonicalExplicitActionIds,
  MAX_WORK_ITEM_ACTIONS,
  validateGeneratedCompletionGate,
} from './workflow.js';

export const MAX_REPLAN_ADDED_ACTIONS = 8;

function cleanProposalId(value) {
  const id = typeof value === 'string' ? value.trim().slice(0, 128) : '';
  if (!id) throw new Error('Work Center plan proposal requires proposalId');
  return id;
}

function replanBarrierFrom(action) {
  return (Array.isArray(action?.context) ? action.context : [])
    .find(entry => entry?.type === 'replan-barrier') || null;
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

function dependencyAncestors(stageId, stagesById) {
  const ancestors = new Set();
  const visit = id => {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    for (const dependencyId of stagesById.get(id)?.dependsOnStageIds || []) visit(dependencyId);
  };
  for (const dependencyId of stagesById.get(stageId)?.dependsOnStageIds || []) visit(dependencyId);
  return ancestors;
}

function validateReviewRemediationGate(workflowSnapshot, reviewAction, addedIds) {
  if (reviewAction?.type !== 'review') return;
  const stages = (workflowSnapshot.stages || []).filter(stage => stage.type !== 'triage');
  const byId = new Map(stages.map(stage => [stage.id, stage]));
  const freshReviews = stages.filter(stage => (
    stage.type === 'review'
    && addedIds.has(stage.id)
    && addedIds.has(stage.changesRequestedStageId)
    && dependencyAncestors(stage.id, byId).has(reviewAction.stageId)
  ));
  const gate = stages.find(stage => stage.type === 'deliver')
    || stages.find(stage => stage.type === 'review'
      && !stages.some(candidate => (candidate.dependsOnStageIds || []).includes(stage.id)));
  const gateAncestors = gate ? dependencyAncestors(gate.id, byId) : new Set();
  const gatedReviews = freshReviews.filter(review => (
    gate?.id === review.id || gateAncestors.has(review.id)
  ));
  const addedWork = stages.filter(stage => (
    addedIds.has(stage.id) && stage.type !== 'review' && stage.type !== 'deliver'
  ));
  const uncovered = addedWork.filter(stage => (
    !gatedReviews.some(review => dependencyAncestors(review.id, byId).has(stage.id))
  ));
  if (addedWork.length === 0 || gatedReviews.length === 0 || uncovered.length > 0) {
    const suffix = uncovered.length > 0 ? `; uncovered Actions: ${uncovered.map(stage => stage.id).join(', ')}` : '';
    throw new Error(`Work Center changes_requested additive plan requires remediation and a fresh review covering every added Action before delivery${suffix}`);
  }
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
  const patchedActionIds = new Set();
  for (const raw of Array.isArray(patches) ? patches : []) {
    const actionId = typeof raw?.actionId === 'string' ? raw.actionId.trim() : '';
    const action = actions.find(candidate => candidate.id === actionId);
    if (!action || action.status !== 'ready' || action.attempt !== 0) {
      throw new Error(`Work Center dependency patch target must be an unattempted ready Action: ${actionId || '(missing)'}`);
    }
    if (patchedActionIds.has(action.id)) {
      throw new Error(`Work Center dependency patch target is duplicated: ${action.id}`);
    }
    patchedActionIds.add(action.id);
    const addDependsOnActionIds = canonicalExplicitActionIds(
      raw.addDependsOnActionIds,
      'dependency patch',
    );
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

export function applyAdditivePlanProposal({
  workItem, actions, proposal, availableVpIds = null, reviewAction = null,
}) {
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
  const canonicalActions = proposal.actions.map(raw => {
    const id = canonicalActionId(raw?.id);
    if (!id || existingIds.has(id) || addedIds.has(id)) {
      throw new Error(`Work Center additive Action id is missing or already exists: ${id || '(missing)'}`);
    }
    addedIds.add(id);
    const hasReturnTarget = Object.hasOwn(raw, 'changesRequestedActionId');
    return {
      ...raw,
      id,
      dependsOnActionIds: canonicalExplicitActionIds(
        raw.dependsOnActionIds,
        `Action "${id}" dependencies`,
      ),
      ...(hasReturnTarget
        ? {
            changesRequestedActionId: canonicalExplicitActionId(
              raw.changesRequestedActionId,
              `Action "${id}" review target`,
            ),
          }
        : {}),
    };
  });
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
    ...canonicalActions,
  ];
  const orderedActions = stableTopologicalActions(mergedActions);
  validateGeneratedCompletionGate(orderedActions.map(action => ({
    id: action.id,
    type: action.type,
    dependsOnStageIds: action.dependsOnActionIds || [],
  })));
  const rawPlan = {
    workItemType: workItem.workflowSnapshot.workItemType,
    actions: orderedActions,
  };
  const workflowSnapshot = applyGeneratedPlan(synthetic, rawPlan, {
    availableVpIds,
    maxActions: MAX_WORK_ITEM_ACTIONS,
  });
  validateReviewRemediationGate(workflowSnapshot, reviewAction, addedIds);
  const addedStages = workflowSnapshot.stages.filter(stage => addedIds.has(stage.id));
  return {
    proposalId,
    basePlanRevision,
    workflowSnapshot,
    nextActions: addedStages.map(stage => actionForStage(stage, { ...workItem, workflowSnapshot }, [])),
    dependencyPatches,
  };
}

export function applyCoordinatorReplan({ workItem, actions, proposal, availableVpIds = null }) {
  if (workItem.workflowSnapshot?.executionMode !== 'graph'
      || workItem.workflowSnapshot?.planningMode !== 'ai') {
    throw new Error('Work Center Coordinator replan requires an AI-planned Action graph');
  }
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new Error('Work Center Coordinator replan must be an object');
  }
  const proposalId = cleanProposalId(proposal.proposalId);
  const basePlanRevision = Number(proposal.basePlanRevision);
  if (!Number.isInteger(basePlanRevision) || basePlanRevision !== workItem.planRevision) {
    throw new Error('Work Center Coordinator replan has a stale basePlanRevision');
  }
  if (!Array.isArray(proposal.actions) || proposal.actions.length < 1 || proposal.actions.length > 8) {
    throw new Error('Work Center Coordinator replan requires between 1 and 8 unfinished Actions');
  }

  const active = actions.filter(candidate => !['superseded', 'cancelled'].includes(candidate.status));
  const completed = active.filter(candidate => candidate.status === 'completed');
  const completedStageIds = new Set(completed.map(candidate => candidate.stageId));
  const unfinished = active.filter(candidate => candidate.status !== 'completed');
  const unfinishedByStage = new Map(unfinished.map(candidate => [candidate.stageId, candidate]));
  const historicalStageIds = new Set(actions.map(candidate => candidate.stageId));
  const currentStages = new Map((workItem.workflowSnapshot.stages || []).map(stage => [stage.id, stage]));
  const futureStageIds = new Set();

  const normalizedFuture = proposal.actions.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Work Center Coordinator replan requires full Action specifications');
    }
    const id = canonicalActionId(raw.id);
    if (!id || futureStageIds.has(id) || completedStageIds.has(id)) {
      throw new Error(`Work Center Coordinator Action id is missing, duplicated, or completed: ${id || '(missing)'}`);
    }
    if (historicalStageIds.has(id) && !unfinishedByStage.has(id)) {
      throw new Error(`Work Center Coordinator Action reuses historical stage identity: ${id}`);
    }
    futureStageIds.add(id);
    const dependsOnActionIds = canonicalExplicitActionIds(
      raw.dependsOnActionIds,
      `Coordinator Action "${id}" dependencies`,
    );
    for (const dependencyId of dependsOnActionIds) {
      if (!completedStageIds.has(dependencyId) && !futureStageIds.has(dependencyId)) {
        throw new Error(`Work Center Coordinator Action "${id}" references a missing or future dependency "${dependencyId}"`);
      }
    }
    return {
      ...raw,
      id,
      dependsOnActionIds,
      ...(Object.hasOwn(raw, 'changesRequestedActionId')
        ? {
            changesRequestedActionId: canonicalExplicitActionId(
              raw.changesRequestedActionId,
              `Coordinator Action "${id}" review target`,
            ),
          }
        : {}),
    };
  });

  const completedInputs = completed.filter(candidate => candidate.type !== 'triage').map(candidate => {
    const stage = currentStages.get(candidate.stageId);
    if (!stage) throw new Error(`Work Center completed Action is missing from the frozen workflow: ${candidate.stageId}`);
    return planActionFromStage(stage);
  });
  const synthetic = {
    ...workItem,
    workflowSnapshot: {
      ...workItem.workflowSnapshot,
      actionTemplates: [],
      stages: [workItem.workflowSnapshot.stages[0]],
    },
  };
  const workflowSnapshot = applyGeneratedPlan(synthetic, {
    workItemType: workItem.workflowSnapshot.workItemType,
    actions: [...completedInputs, ...normalizedFuture],
  }, { availableVpIds, maxActions: MAX_WORK_ITEM_ACTIONS });
  const stageById = new Map(workflowSnapshot.stages.map(stage => [stage.id, stage]));

  return {
    proposalId,
    reason: typeof proposal.reason === 'string' ? proposal.reason.trim().slice(0, 4_000) : '',
    basePlanRevision,
    workflowSnapshot,
    unfinished,
    nextActions: normalizedFuture.map(input => {
      const prior = unfinishedByStage.get(input.id) || null;
      const nextAction = actionForStage(stageById.get(input.id), { ...workItem, workflowSnapshot }, []);
      return { prior, nextAction };
    }),
  };
}

export function applyReplanMutation({ workItem, action, actions, proposal, availableVpIds = null }) {
  if (workItem.workflowSnapshot?.executionMode !== 'graph'
      || action?.type !== 'triage'
      || !action?.stageId?.startsWith('replan-')) {
    throw new Error('Work Center replan mutation requires a replan triage Action');
  }
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new Error('Work Center replan mutation must be an object');
  }
  const proposalId = cleanProposalId(proposal.proposalId);
  const basePlanRevision = Number(proposal.basePlanRevision);
  if (!Number.isInteger(basePlanRevision) || basePlanRevision !== workItem.planRevision) {
    throw new Error('Work Center replan mutation has a stale basePlanRevision');
  }
  const barrier = replanBarrierFrom(action);
  if (!barrier || !Array.isArray(barrier.candidateActionIds)) {
    throw new Error('Work Center replan Action is missing its frozen candidate set');
  }
  const candidateIds = barrier.candidateActionIds;
  for (const field of ['retain', 'replace', 'remove', 'add']) {
    if (!Array.isArray(proposal[field])) {
      throw new Error(`Work Center replan mutation requires ${field} to be an array`);
    }
  }
  if (proposal.add.length > MAX_REPLAN_ADDED_ACTIONS) {
    throw new Error(`Work Center replan mutation can add at most ${MAX_REPLAN_ADDED_ACTIONS} new Actions`);
  }
  const actionById = new Map(actions.map(candidate => [candidate.id, candidate]));
  const candidates = new Map(candidateIds.map(id => [id, actionById.get(id)]));
  for (const [id, candidate] of candidates) {
    if (!candidate || candidate.status !== 'superseded') {
      throw new Error(`Work Center replan candidate is missing or no longer superseded: ${id}`);
    }
  }

  const classified = new Set();
  const classify = (actionId, kind) => {
    const id = typeof actionId === 'string' ? actionId.trim() : '';
    if (!candidates.has(id)) throw new Error(`Work Center replan ${kind} references a non-candidate Action: ${id || '(missing)'}`);
    if (classified.has(id)) throw new Error(`Work Center replan candidate is classified more than once: ${id}`);
    classified.add(id);
    return candidates.get(id);
  };
  const retained = (Array.isArray(proposal.retain) ? proposal.retain : []).map(entry => ({
    action: classify(entry?.actionId, 'retain'), input: entry?.action,
  }));
  const replaced = (Array.isArray(proposal.replace) ? proposal.replace : []).map(entry => ({
    action: classify(entry?.actionId, 'replace'), input: entry?.action,
  }));
  const removed = (Array.isArray(proposal.remove) ? proposal.remove : []).map(id => classify(id, 'remove'));
  const missing = candidateIds.filter(id => !classified.has(id));
  if (missing.length > 0) throw new Error(`Work Center replan must classify every frozen candidate: ${missing.join(', ')}`);

  const completed = actions.filter(candidate => candidate.status === 'completed' && candidate.type !== 'triage');
  const currentStages = new Map((workItem.workflowSnapshot.stages || []).map(stage => [stage.id, stage]));
  const historicalStageIds = new Set(actions.map(candidate => candidate.stageId));
  const futureIds = new Set();
  const canonicalFuture = (raw, expectedId = null) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Work Center replan classification requires a full Action specification');
    }
    const id = canonicalActionId(raw.id);
    if (!id || (expectedId && id !== expectedId)) {
      throw new Error(`Work Center retained Action must keep stage identity: ${expectedId || '(missing)'}`);
    }
    if (futureIds.has(id)) throw new Error(`Work Center replan Action id is duplicated: ${id}`);
    futureIds.add(id);
    return {
      ...raw,
      id,
      dependsOnActionIds: canonicalExplicitActionIds(raw.dependsOnActionIds, `Action "${id}" dependencies`),
      ...(Object.hasOwn(raw, 'changesRequestedActionId')
        ? {
            changesRequestedActionId: canonicalExplicitActionId(
              raw.changesRequestedActionId,
              `Action "${id}" review target`,
            ),
          }
        : {}),
    };
  };
  const retainedInputs = retained.map(entry => canonicalFuture(entry.input, entry.action.stageId));
  const replacementInputs = replaced.map(entry => {
    const input = canonicalFuture(entry.input);
    if (historicalStageIds.has(input.id)) throw new Error(`Work Center replacement Action reuses historical stage identity: ${input.id}`);
    return input;
  });
  const addedInputs = (Array.isArray(proposal.add) ? proposal.add : []).map(raw => {
    const input = canonicalFuture(raw);
    if (historicalStageIds.has(input.id)) throw new Error(`Work Center added Action reuses historical stage identity: ${input.id}`);
    return input;
  });
  const completedInputs = completed.map(candidate => {
    const stage = currentStages.get(candidate.stageId);
    if (!stage) throw new Error(`Work Center completed Action is missing from the frozen workflow: ${candidate.stageId}`);
    return planActionFromStage(stage);
  });
  const synthetic = {
    ...workItem,
    workflowSnapshot: { ...workItem.workflowSnapshot, actionTemplates: [], stages: [workItem.workflowSnapshot.stages[0]] },
  };
  const workflowSnapshot = applyGeneratedPlan(synthetic, {
    workItemType: workItem.workflowSnapshot.workItemType,
    actions: stableTopologicalActions([...completedInputs, ...retainedInputs, ...replacementInputs, ...addedInputs]),
  }, { availableVpIds, maxActions: MAX_WORK_ITEM_ACTIONS });
  const stageById = new Map(workflowSnapshot.stages.map(stage => [stage.id, stage]));
  const context = (Array.isArray(action.context) ? action.context : [])
    .filter(entry => entry?.type !== 'replan-barrier' && entry?.type !== 'input');
  return {
    proposalId,
    basePlanRevision,
    workflowSnapshot,
    retain: retained.map(entry => ({
      action: entry.action,
      nextAction: actionForStage(stageById.get(entry.action.stageId), { ...workItem, workflowSnapshot }, context),
    })),
    replace: replaced.map((entry, index) => ({
      action: entry.action,
      nextAction: {
        ...actionForStage(stageById.get(replacementInputs[index].id), { ...workItem, workflowSnapshot }, context),
        replacesActionId: entry.action.id,
      },
    })),
    add: addedInputs.map(input => actionForStage(stageById.get(input.id), { ...workItem, workflowSnapshot }, context)),
    remove: removed.map(candidate => candidate.id),
  };
}
