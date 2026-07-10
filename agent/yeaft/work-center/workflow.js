const STAGE_TYPES = new Set(['triage', 'implement', 'test', 'review', 'deliver', 'research', 'write', 'custom']);
const ASSIGNMENT_MODES = new Set(['auto', 'pool', 'fixed']);
const MODEL_MODES = new Set(['inherit', 'primary', 'fast', 'specific']);
const MODEL_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const DEFAULT_SOFTWARE_CHANGE_STAGES = Object.freeze([
  {
    id: 'triage', name: 'Triage', type: 'triage',
    assignmentPolicy: { mode: 'auto', capability: 'triage', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] },
    modelPolicy: { mode: 'inherit', model: null, effort: null },
    maxAttempts: 2,
  },
  {
    id: 'implement', name: 'Implement', type: 'implement',
    assignmentPolicy: { mode: 'auto', capability: 'implement', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] },
    modelPolicy: { mode: 'inherit', model: null, effort: null },
    maxAttempts: 2,
  },
  {
    id: 'review', name: 'Review', type: 'review',
    assignmentPolicy: { mode: 'auto', capability: 'review', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: ['implement'] },
    modelPolicy: { mode: 'inherit', model: null, effort: null },
    maxAttempts: 2,
    changesRequestedStageId: 'implement',
  },
  {
    id: 'deliver', name: 'Deliver', type: 'deliver',
    assignmentPolicy: { mode: 'auto', capability: 'deliver', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] },
    modelPolicy: { mode: 'inherit', model: null, effort: null },
    maxAttempts: 2,
  },
]);

export const RUN_OUTCOMES = Object.freeze([
  'completed',
  'waiting',
  'retryable',
  'failed',
]);

function cleanId(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
}

export function normalizeAssignmentPolicy(value, stageType = 'custom') {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = ASSIGNMENT_MODES.has(source.mode) ? source.mode : 'auto';
  const fixedVpId = typeof source.fixedVpId === 'string' && source.fixedVpId.trim()
    ? source.fixedVpId.trim()
    : null;
  const candidateVpIds = uniqueStrings(source.candidateVpIds);
  if (mode === 'fixed' && !fixedVpId) throw new Error('Fixed Work Center assignment requires fixedVpId');
  if (mode === 'pool' && candidateVpIds.length === 0) throw new Error('Work Center VP pool cannot be empty');
  return {
    mode,
    capability: cleanId(source.capability, stageType),
    candidateVpIds,
    fixedVpId,
    separateFromStageTypes: uniqueStrings(source.separateFromStageTypes),
  };
}

export function normalizeModelPolicy(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = MODEL_MODES.has(source.mode) ? source.mode : 'inherit';
  const model = typeof source.model === 'string' && source.model.trim() ? source.model.trim() : null;
  const effort = MODEL_EFFORTS.has(source.effort) ? source.effort : null;
  if (mode === 'specific' && !model) throw new Error('Specific Work Center model policy requires a model');
  return { mode, model, effort };
}

export function normalizeWorkflowDefinition(value, index = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Work Center workflow must be an object');
  }
  const id = cleanId(value.id, `workflow-${index + 1}`);
  const name = String(value.name || id).trim() || id;
  if (!Array.isArray(value.stages) || value.stages.length === 0) {
    throw new Error(`Work Center workflow "${id}" requires at least one stage`);
  }
  const seen = new Set();
  const stages = value.stages.map((rawStage, stageIndex) => {
    const source = rawStage && typeof rawStage === 'object' ? rawStage : {};
    const type = STAGE_TYPES.has(source.type) ? source.type : 'custom';
    const stageId = cleanId(source.id, `${type}-${stageIndex + 1}`);
    if (seen.has(stageId)) throw new Error(`Duplicate Work Center stage id: ${stageId}`);
    seen.add(stageId);
    const stage = {
      id: stageId,
      name: String(source.name || stageId).trim() || stageId,
      type,
      instruction: typeof source.instruction === 'string' ? source.instruction.trim() : '',
      assignmentPolicy: normalizeAssignmentPolicy(source.assignmentPolicy, type),
      modelPolicy: normalizeModelPolicy(source.modelPolicy),
      maxAttempts: Math.min(Math.max(Number(source.maxAttempts) || 2, 1), 5),
    };
    if (type === 'review') {
      stage.changesRequestedStageId = cleanId(source.changesRequestedStageId, 'implement');
    }
    return stage;
  });
  for (const stage of stages) {
    if (stage.type === 'review' && !seen.has(stage.changesRequestedStageId)) {
      throw new Error(`Review stage "${stage.id}" points to missing stage "${stage.changesRequestedStageId}"`);
    }
  }
  return { version: 1, id, name, stages };
}

export function defaultWorkCenterSettings() {
  return {
    version: 1,
    revision: 1,
    defaultWorkflowId: 'software-change',
    startImmediately: true,
    defaultWorkDir: '',
    workflows: [normalizeWorkflowDefinition({
      id: 'software-change',
      name: 'Software change',
      stages: DEFAULT_SOFTWARE_CHANGE_STAGES,
    })],
  };
}

export function normalizeWorkCenterSettings(value) {
  const defaults = defaultWorkCenterSettings();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const workflows = Array.isArray(source.workflows) && source.workflows.length > 0
    ? source.workflows.map(normalizeWorkflowDefinition)
    : defaults.workflows;
  const workflowIds = new Set();
  for (const workflow of workflows) {
    if (workflowIds.has(workflow.id)) throw new Error(`Duplicate Work Center workflow id: ${workflow.id}`);
    workflowIds.add(workflow.id);
  }
  const defaultWorkflowId = workflowIds.has(source.defaultWorkflowId)
    ? source.defaultWorkflowId
    : workflows[0].id;
  const revision = Number.isInteger(source.revision) && source.revision > 0 ? source.revision : 1;
  return {
    version: 1,
    revision,
    defaultWorkflowId,
    startImmediately: source.startImmediately !== false,
    defaultWorkDir: typeof source.defaultWorkDir === 'string' ? source.defaultWorkDir.trim() : '',
    workflows,
  };
}

export function resolveWorkflowSnapshot(settings, workflowId, stageOverrides = {}) {
  const normalized = normalizeWorkCenterSettings(settings);
  const id = workflowId || normalized.defaultWorkflowId;
  const workflow = normalized.workflows.find(item => item.id === id);
  if (!workflow) throw new Error(`Unsupported Work Center workflow: ${id}`);
  const overrides = stageOverrides && typeof stageOverrides === 'object' && !Array.isArray(stageOverrides)
    ? stageOverrides
    : {};
  return normalizeWorkflowDefinition({
    ...workflow,
    stages: workflow.stages.map(stage => {
      const override = overrides[stage.id];
      if (!override || typeof override !== 'object' || Array.isArray(override)) return stage;
      return {
        ...stage,
        assignmentPolicy: override.assignmentPolicy
          ? { ...stage.assignmentPolicy, ...override.assignmentPolicy }
          : stage.assignmentPolicy,
        modelPolicy: override.modelPolicy
          ? { ...stage.modelPolicy, ...override.modelPolicy }
          : stage.modelPolicy,
      };
    }),
  });
}

const LEGACY_SOFTWARE_CHANGE_VPS = Object.freeze({
  triage: 'omni',
  implement: 'linus',
  review: 'martin',
  deliver: 'linus',
});

function workflowFrom(source = 'software-change') {
  if (source && typeof source === 'object' && source.workflowSnapshot?.stages) {
    return normalizeWorkflowDefinition(source.workflowSnapshot);
  }
  if (source && typeof source === 'object' && source.stages) return normalizeWorkflowDefinition(source);
  const settings = defaultWorkCenterSettings();
  const workflow = resolveWorkflowSnapshot(settings, typeof source === 'string' ? source : 'software-change');
  // Existing WorkItems did not persist a workflow snapshot. Preserve their
  // historical deterministic assignments; only newly created WorkItems use
  // pool selection. This avoids silently changing in-flight durable work.
  return {
    ...workflow,
    stages: workflow.stages.map(stage => ({
      ...stage,
      assignmentPolicy: {
        ...stage.assignmentPolicy,
        mode: 'fixed',
        fixedVpId: LEGACY_SOFTWARE_CHANGE_VPS[stage.type],
      },
    })),
  };
}

export function getWorkflowSteps(source = 'software-change') {
  return workflowFrom(source).stages;
}

export function getStep(source, stageIdOrType) {
  return getWorkflowSteps(source).find(stage => stage.id === stageIdOrType)
    || getWorkflowSteps(source).find(stage => stage.type === stageIdOrType)
    || null;
}

export function getNextStep(source, stageIdOrType, result = {}) {
  const steps = getWorkflowSteps(source);
  const index = steps.findIndex(stage => stage.id === stageIdOrType)
    !== -1
    ? steps.findIndex(stage => stage.id === stageIdOrType)
    : steps.findIndex(stage => stage.type === stageIdOrType);
  if (index === -1) throw new Error(`Work Center stage ${stageIdOrType} is not in the workflow snapshot`);
  const current = steps[index];
  if (current.type === 'review') {
    if (result.reviewDecision === 'changes_requested') {
      return steps.find(stage => stage.id === current.changesRequestedStageId) || null;
    }
    if (result.reviewDecision !== 'approved') {
      throw new Error('Completed review requires approved or changes_requested');
    }
  }
  return steps[index + 1] || null;
}

function renderContext(context = []) {
  if (!Array.isArray(context) || context.length === 0) return '';
  const blocks = context.map(entry => {
    const evidence = Array.isArray(entry.evidence) && entry.evidence.length > 0
      ? `\nEvidence:\n${entry.evidence.map(item => {
          const status = item.status ? ` [${item.status}]` : '';
          const ref = item.ref ? ` (${item.ref})` : '';
          return `- ${item.kind}: ${item.label}${status}${ref}`;
        }).join('\n')}`
      : '';
    const decision = entry.reviewDecision ? `\nReview decision: ${entry.reviewDecision}` : '';
    const waitingReason = entry.waitingReason ? `\nWaiting reason: ${entry.waitingReason}` : '';
    const answer = entry.answer ? `\nUser answer: ${entry.answer}` : '';
    const source = entry.sourceTitle ? ` from ${entry.sourceTitle}` : '';
    return `### ${entry.type}${source} (${entry.vpId || entry.role || 'unknown VP'})\n${entry.summary || '(no summary)'}${decision}${waitingReason}${answer}${evidence}`;
  });
  return `\n\nReusable Work Center context and prior Action results:\n${blocks.join('\n\n')}`;
}

export function actionInstruction(stage, workItem, context = []) {
  const criteria = (workItem.acceptanceCriteria || []).map(item => `- ${item}`).join('\n') || '- No explicit criteria';
  const common = `WorkItem: ${workItem.title}\nGoal: ${workItem.goal}\nAcceptance criteria:\n${criteria}${renderContext(context)}`;
  if (stage.instruction) return `${common}\n\n${stage.instruction}`;
  switch (stage.type) {
    case 'triage':
      return `${common}\n\nAnalyze the request, verify scope and risks, and make the contract executable. Do not implement yet. If the goal or acceptance criteria need refinement, submit a contractPatch.`;
    case 'implement':
      return `${common}\n\nImplement the smallest correct change in the supplied work directory. Add and run relevant tests. Use the prior triage/review findings. Do not approve your own work.`;
    case 'test':
      return `${common}\n\nVerify the implementation against the acceptance criteria. Run focused tests and report reproducible evidence. Do not modify unrelated code.`;
    case 'review':
      return `${common}\n\nReview the implementation and evidence independently. Return approved or changes_requested with concrete findings.`;
    case 'deliver':
      return `${common}\n\nDeliver the approved change using the repository release policy. Verify the final remote state and provide evidence.`;
    case 'research':
      return `${common}\n\nResearch the question using verifiable sources. Separate evidence from inference and return a concise synthesis.`;
    case 'write':
      return `${common}\n\nProduce the requested written deliverable, then verify it against every acceptance criterion.`;
    default:
      return `${common}\n\nComplete this stage and return verifiable evidence.`;
  }
}

export function actionForStage(stage, workItem, context = []) {
  return {
    type: stage.type,
    stageId: stage.id,
    assignmentPolicy: stage.assignmentPolicy,
    modelPolicy: stage.modelPolicy,
    // Storage compatibility for databases created before assignment policies.
    requiredRole: stage.assignmentPolicy.mode === 'fixed' ? stage.assignmentPolicy.fixedVpId : '',
    context,
    instruction: actionInstruction(stage, workItem, context),
    maxAttempts: stage.maxAttempts,
  };
}

export function initialActionFor(workItem) {
  const stage = getWorkflowSteps(workItem)[0];
  return actionForStage(stage, workItem, []);
}

export function actionContextFromRuns(runs = []) {
  return runs
    .filter(run => run && run.summary)
    .map(run => ({
      type: run.actionType || 'action',
      vpId: run.vpSnapshot?.id || null,
      role: run.roleSnapshot?.id || null,
      summary: run.summary,
      evidence: Array.isArray(run.evidence) ? run.evidence : [],
      reviewDecision: run.reviewDecision || null,
    }));
}
