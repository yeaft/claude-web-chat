import { randomUUID } from 'node:crypto';
import {
  BUILT_IN_ACTION_TYPES,
  MAX_WORK_ITEM_ACTIONS,
  canonicalActionId,
  canonicalActionInstruction,
  normalizeActionBrief,
  normalizeWorkCenterSettings,
  taskSpecificActionBrief,
} from './workflow.js';
import {
  DYNAMIC_COORDINATION_MODE,
  DYNAMIC_EXECUTION_SCHEMA_VERSION,
  isDynamicWorkItem,
} from './execution-mode.js';

export {
  DYNAMIC_COORDINATION_MODE,
  DYNAMIC_EXECUTION_SCHEMA_VERSION,
  isDynamicWorkItem,
};
const DYNAMIC_ACTION_LIMIT = 8;
const DYNAMIC_WORKSPACE_MODES = new Set(['read', 'shared', 'isolated-write', 'integrate']);

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
}

function requiredText(value, name, limit = 2_000) {
  const text = typeof value === 'string' ? value.trim().slice(0, limit) : '';
  if (!text) throw new Error(`Work Center dynamic Action ${name} is required`);
  return text;
}

/**
 * Build the frozen policy catalog for a Coordinator-driven WorkItem. The legacy
 * workflow_snapshot column remains the on-disk compatibility envelope, but new
 * entries contain no stages, dependencies, or precomputed successors.
 */
export function resolveDynamicActionPolicySnapshot(settings, requestedWorkItemType = null) {
  const normalized = normalizeWorkCenterSettings(settings);
  const requested = typeof requestedWorkItemType === 'string'
    && requestedWorkItemType.trim()
    && requestedWorkItemType.trim().toLowerCase() !== 'auto'
    ? canonicalActionId(requestedWorkItemType, '').slice(0, 64)
    : '';
  return {
    version: 2,
    id: 'coordinator-driven',
    name: 'Coordinator driven',
    planningMode: 'coordinator',
    executionMode: 'dynamic',
    workItemType: requested || null,
    globalInstructions: normalized.globalInstructions,
    modelPolicy: normalized.modelPolicy,
    coordinatorModelPolicy: normalized.coordinatorModelPolicy,
    actionModelPolicies: normalized.actionModelPolicies,
    actionInstructions: normalized.actionInstructions,
    actionTemplates: BUILT_IN_ACTION_TYPES.filter(type => type !== 'triage').map(type => ({ type })),
  };
}

function normalizeSourceActionIds(value, actions) {
  const ids = uniqueStrings(value);
  const available = new Set(actions.map(action => action.id));
  for (const id of ids) {
    if (!available.has(id)) throw new Error(`Work Center dynamic Action references an unknown source Action: ${id}`);
  }
  return ids;
}

export function normalizeDynamicActionClosures(value, actions) {
  if (!Array.isArray(value)) return [];
  const byId = new Map(actions.map(action => [action.id, action]));
  const seen = new Set();
  return value.map(raw => {
    const actionId = requiredText(raw?.actionId, 'close actionId', 256);
    if (seen.has(actionId)) throw new Error(`Work Center dynamic Action close target is duplicated: ${actionId}`);
    seen.add(actionId);
    const action = byId.get(actionId);
    if (!action || !['waiting', 'failed'].includes(action.status)) {
      throw new Error(`Work Center can close only a waiting or failed Action: ${actionId}`);
    }
    return {
      actionId,
      reason: requiredText(raw?.reason, 'close reason', 2_000),
    };
  });
}

function normalizeSupersededActionIds(value, actions) {
  const ids = uniqueStrings(value);
  const byId = new Map(actions.map(action => [action.id, action]));
  for (const id of ids) {
    const action = byId.get(id);
    if (!action || !['ready', 'waiting', 'failed'].includes(action.status)) {
      throw new Error(`Work Center can supersede only a non-running unfinished Action: ${id}`);
    }
  }
  return ids;
}

/**
 * Normalize one just-in-time Coordinator decision into concrete durable Action
 * records. sourceActionIds are audit/context links only and never gate dispatch.
 */
export function prepareDynamicActionMutation({
  workItem,
  actions,
  decision,
  availableVpIds = null,
}) {
  if (!isDynamicWorkItem(workItem)) {
    throw new Error('Work Center dynamic Action creation requires a Coordinator-driven WorkItem');
  }
  const requested = Array.isArray(decision?.actions) ? decision.actions : [];
  if (requested.length < 1 || requested.length > DYNAMIC_ACTION_LIMIT) {
    throw new Error('Work Center Coordinator must create between 1 and 8 currently justified Actions');
  }
  const historicalCount = Array.isArray(actions) ? actions.length : 0;
  if (historicalCount + requested.length > MAX_WORK_ITEM_ACTIONS) {
    throw new Error(`Work Center cannot exceed ${MAX_WORK_ITEM_ACTIONS} Actions`);
  }
  const knownVpIds = Array.isArray(availableVpIds)
    ? new Set(availableVpIds.map(value => String(value || '').trim()).filter(Boolean))
    : null;
  const closeActions = normalizeDynamicActionClosures(decision.closeActions, actions);
  const closeActionIds = new Set(closeActions.map(entry => entry.actionId));
  const supersedeActionIds = normalizeSupersededActionIds(decision.supersedeActionIds, actions);
  if (supersedeActionIds.some(actionId => closeActionIds.has(actionId))) {
    throw new Error('Work Center cannot both close and supersede the same Action');
  }
  const effectiveWorkItem = {
    ...workItem,
    ...(decision.contractPatch || {}),
  };
  const createdActions = requested.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Work Center Coordinator Action specification must be an object');
    }
    if (Object.hasOwn(raw, 'dependsOnActionIds') || Object.hasOwn(raw, 'dependsOnStageIds')) {
      throw new Error('Coordinator-driven Actions cannot contain dependency fields');
    }
    const type = canonicalActionId(raw.type, 'custom').slice(0, 64);
    if (type === 'triage') throw new Error('Coordinator-driven WorkItems do not create triage Actions');
    const brief = normalizeActionBrief({
      objective: requiredText(raw.objective, 'objective'),
      approach: requiredText(raw.approach, 'approach'),
      expectedOutcome: requiredText(raw.expectedOutcome, 'expectedOutcome'),
    }, type);
    if (!taskSpecificActionBrief(brief, type)) {
      throw new Error(`Work Center dynamic Action ${index + 1} must use a task-specific brief`);
    }
    const candidateVpIds = uniqueStrings(raw.candidateVpIds);
    if (knownVpIds) {
      const unavailable = candidateVpIds.find(vpId => !knownVpIds.has(vpId));
      if (unavailable) throw new Error(`Work Center dynamic Action references unavailable VP "${unavailable}"`);
    }
    if (type === 'create_vp' && !knownVpIds) {
      throw new Error('Work Center create_vp Action requires the available VP inventory');
    }
    if (type === 'create_vp' && candidateVpIds.length !== 1) {
      throw new Error('Work Center create_vp Action requires exactly one existing VP and an assignment reason');
    }
    const assignmentReason = candidateVpIds.length > 0
      ? requiredText(raw.assignmentReason, 'assignmentReason', 1_000)
      : '';
    const id = randomUUID();
    const workspaceMode = DYNAMIC_WORKSPACE_MODES.has(raw.workspaceMode)
      ? raw.workspaceMode
      : 'shared';
    const sourceActionIds = normalizeSourceActionIds(raw.sourceActionIds, actions);
    if (workspaceMode === 'integrate' && sourceActionIds.length === 0) {
      throw new Error('Work Center integrate Action requires sourceActionIds');
    }
    if (workspaceMode === 'integrate') {
      const byId = new Map(actions.map(candidate => [candidate.id, candidate]));
      const invalid = sourceActionIds.find(sourceId => (
        byId.get(sourceId)?.workspaceMode !== 'isolated-write'
        || byId.get(sourceId)?.status !== 'completed'
      ));
      if (invalid) {
        throw new Error(`Work Center integrate Action source is not a completed isolated write: ${invalid}`);
      }
    }
    const action = {
      id,
      type,
      // stage_id is retained only as a legacy storage alias. Dynamic dispatch
      // and Coordinator references use the durable Action id above.
      stageId: id,
      assignmentPolicy: candidateVpIds.length > 0 ? {
        mode: 'planned',
        capability: canonicalActionId(raw.capability, type),
        candidateVpIds,
        fixedVpId: null,
        assignmentReason,
        separateFromStageTypes: uniqueStrings(raw.separateFromActionTypes),
      } : {
        mode: 'auto',
        capability: canonicalActionId(raw.capability, type),
        candidateVpIds: [],
        fixedVpId: null,
        assignmentReason: '',
        separateFromStageTypes: uniqueStrings(raw.separateFromActionTypes),
      },
      modelPolicy: workItem.workflowSnapshot?.actionModelPolicies?.[type]
        || workItem.workflowSnapshot?.actionModelPolicies?.custom
        || workItem.workflowSnapshot?.modelPolicy
        || null,
      dependsOnStageIds: [],
      sourceActionIds,
      workspaceMode,
      changesRequestedStageId: null,
      requiredRole: '',
      brief,
      context: [],
      maxAttempts: Math.min(Math.max(Number(raw.maxAttempts) || 2, 1), 5),
    };
    action.instruction = canonicalActionInstruction(effectiveWorkItem, action, []);
    return action;
  });
  const workItemType = canonicalActionId(
    decision.workItemType || workItem.workflowSnapshot?.workItemType,
    '',
  ).slice(0, 64);
  if (!workItemType) throw new Error('Work Center Coordinator must choose a specific WorkItem type');
  return {
    createdActions,
    closeActions,
    supersedeActionIds,
    contractPatch: decision.contractPatch || null,
    workItemType,
  };
}

function normalizeEvidenceRunIds(value) {
  return uniqueStrings(value);
}

export function normalizeDynamicCompletion(value, acceptanceCriteria) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Work Center Coordinator completion is required');
  }
  const criteria = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
  if (criteria.length === 0) throw new Error('Work Center completion requires acceptance criteria');
  if (!Array.isArray(value.acceptanceResults) || value.acceptanceResults.length !== criteria.length) {
    throw new Error('Work Center completion requires one ordered result for every acceptance criterion');
  }
  const acceptanceResults = value.acceptanceResults.map((raw, index) => {
    const criterion = typeof raw?.criterion === 'string' ? raw.criterion.trim() : '';
    const status = raw?.status === 'passed' ? 'passed' : '';
    const evidenceRunIds = normalizeEvidenceRunIds(raw?.evidenceRunIds);
    if (criterion !== criteria[index] || !status || evidenceRunIds.length === 0) {
      throw new Error('Work Center completion requires every criterion to pass with owned Run evidence');
    }
    return { criterion, status, evidenceRunIds };
  });
  const evidenceRunIds = normalizeEvidenceRunIds(value.evidenceRunIds);
  if (evidenceRunIds.length === 0) {
    throw new Error('Work Center completion requires at least one evidence Run');
  }
  const acceptanceEvidence = new Set(acceptanceResults.flatMap(result => result.evidenceRunIds));
  if ([...acceptanceEvidence].some(runId => !evidenceRunIds.includes(runId))) {
    throw new Error('Work Center completion evidence must include every acceptance evidence Run');
  }
  return {
    summary: requiredText(value.summary, 'completion summary', 8_000),
    acceptanceResults,
    evidenceRunIds,
    residualRisks: uniqueStrings(value.residualRisks).slice(0, 24),
  };
}
