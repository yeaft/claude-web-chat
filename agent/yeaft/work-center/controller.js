import {
  actionForStage,
  actionInstruction,
  applyGeneratedPlan,
  getNextStep,
  initialActionFor,
  RUN_OUTCOMES,
} from './workflow.js';
import { normalizeEvidence } from './evidence.js';

function normalizeCriteria(value) {
  if (!Array.isArray(value)) return null;
  return value.map(item => String(item).trim()).filter(Boolean);
}

function normalizeContractPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const patch = {};
  if (typeof value.goal === 'string' && value.goal.trim()) patch.goal = value.goal.trim();
  if (Object.prototype.hasOwnProperty.call(value, 'acceptanceCriteria')) {
    const criteria = normalizeCriteria(value.acceptanceCriteria);
    if (!criteria) throw new Error('contractPatch.acceptanceCriteria must be an array');
    patch.acceptanceCriteria = criteria;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function normalizeTerminalResult(result, action) {
  if (!result || !RUN_OUTCOMES.includes(result.outcome)) {
    throw new Error(`Invalid Work Center outcome: ${result?.outcome || '(missing)'}`);
  }
  const normalized = {
    outcome: result.outcome,
    summary: String(result.summary || ''),
    evidence: normalizeEvidence(result.evidence),
    waitingReason: result.waitingReason ? String(result.waitingReason) : null,
    error: result.error ? String(result.error) : null,
    reviewDecision: ['approved', 'changes_requested'].includes(result.reviewDecision)
      ? result.reviewDecision
      : null,
    contractPatch: normalizeContractPatch(result.contractPatch),
    plan: result.plan && typeof result.plan === 'object' && !Array.isArray(result.plan)
      ? result.plan
      : null,
    loopCount: Math.max(0, Number(result.loopCount) || 0),
    toolCount: Math.max(0, Number(result.toolCount) || 0),
  };
  if (normalized.outcome === 'waiting' && !normalized.waitingReason) {
    throw new Error('waiting outcome requires waitingReason');
  }
  if (action.type !== 'triage' && normalized.contractPatch) {
    normalized.outcome = 'failed';
    normalized.error = 'Only triage may submit a WorkItem contractPatch';
    normalized.contractPatch = null;
  }
  if (action.type === 'review' && normalized.outcome === 'completed' && !normalized.reviewDecision) {
    normalized.outcome = 'failed';
    normalized.error = 'Completed review requires approved or changes_requested';
  }
  return normalized;
}

function contextEntry(action, result, run) {
  return {
    type: action.type,
    stageId: action.stageId || action.type,
    vpId: run?.vpSnapshot?.id || action.requiredRole || null,
    role: run?.roleSnapshot?.id || action.requiredRole || null,
    summary: result.summary || '',
    evidence: result.evidence || [],
    reviewDecision: result.reviewDecision || null,
  };
}

export class WorkflowController {
  constructor(store) {
    this.store = store;
  }

  create(input) {
    const draft = {
      ...input,
      workflowTemplate: input.workflowTemplate || 'software-change',
      acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [],
    };
    let firstAction = input.start !== false ? initialActionFor(draft) : null;
    if (firstAction && draft.reuseMemory !== false) {
      const context = this.store.getReusableContext(draft.workDir, draft.id);
      firstAction = {
        ...firstAction,
        context,
        instruction: actionInstruction(firstAction, draft, context),
      };
    }
    return this.store.createWorkItem(draft, firstAction);
  }

  start(id) {
    const detail = this.store.startWorkItemAtomic(id, workItem => {
      const action = initialActionFor(workItem);
      if (workItem.reuseMemory === false) return action;
      const context = this.store.getReusableContext(workItem.workDir, workItem.id);
      return {
        ...action,
        context,
        instruction: actionInstruction(action, workItem, context),
      };
    });
    if (!detail) throw new Error(`WorkItem not found: ${id}`);
    return detail;
  }

  update(id, patch) {
    const updated = this.store.updateWorkItemAtomic(id, patch, initialActionFor);
    if (!updated) throw new Error(`WorkItem not found: ${id}`);
    return this.store.getWorkItemDetail(id);
  }

  cancel(id) {
    const workItem = this.store.cancelWorkItemAtomic(id);
    if (!workItem) throw new Error(`WorkItem not found: ${id}`);
    return this.store.getWorkItemDetail(id);
  }

  guide(id, input = {}) {
    const guidance = typeof input.guidance === 'string' ? input.guidance.trim().slice(0, 8_000) : '';
    if (!guidance) throw new Error('guidance is required');
    const expected = {
      actionId: typeof input.actionId === 'string' ? input.actionId : '',
      revision: Number(input.revision),
    };
    if (!expected.actionId || !Number.isInteger(expected.revision)) {
      throw new Error('actionId and revision are required for guidance');
    }
    const detail = this.store.addActionGuidance(id, guidance, expected, (workItem, previous) => {
      const context = [...(previous.context || []), {
        type: 'guidance',
        role: 'user',
        summary: guidance,
        evidence: [],
      }];
      const step = {
        type: previous.type,
        stageId: previous.stageId || previous.type,
        assignmentPolicy: previous.assignmentPolicy,
        modelPolicy: previous.modelPolicy,
        requiredRole: previous.requiredRole,
      };
      return {
        ...step,
        context,
        instruction: actionInstruction(step, workItem, context),
        maxAttempts: previous.maxAttempts || 2,
      };
    });
    if (!detail) throw new Error(`WorkItem not found: ${id}`);
    return detail;
  }

  retry(id, input = {}) {
    const answer = typeof input.answer === 'string' ? input.answer.trim().slice(0, 8_000) : '';
    const detail = this.store.retryWorkItemAtomic(id, (workItem, previous, previousRun) => {
      if (workItem.status === 'waiting' && !answer) {
        throw new Error('answer is required to resume a waiting WorkItem');
      }
      const step = previous
        ? {
            type: previous.type,
            stageId: previous.stageId || previous.type,
            assignmentPolicy: previous.assignmentPolicy,
            modelPolicy: previous.modelPolicy,
            requiredRole: previous.requiredRole,
          }
        : initialActionFor(workItem);
      const context = Array.isArray(previous?.context) ? [...previous.context] : [];
      if (previousRun) {
        context.push({
          type: previous.type,
          stageId: previous.stageId || previous.type,
          vpId: previousRun.vpSnapshot?.id || previous.requiredRole || null,
          role: previousRun.roleSnapshot?.id || previous.requiredRole || null,
          summary: previousRun.summary || '',
          evidence: normalizeEvidence(previousRun.evidence),
          waitingReason: previousRun.waitingReason || null,
          answer: answer || null,
        });
      }
      return {
        ...step,
        context,
        instruction: actionInstruction(step, workItem, context),
        maxAttempts: previous?.maxAttempts || 2,
      };
    });
    if (!detail) throw new Error(`WorkItem not found: ${id}`);
    return detail;
  }

  submit(runId, ownerBootId, leaseEpoch, rawResult) {
    const activeRun = this.store.getRun(runId);
    const activeAction = activeRun ? this.store.getAction(activeRun.actionId) : null;
    if (!activeRun || !activeAction) throw new Error('Run is stale, cancelled, or already finished');
    const result = normalizeTerminalResult(rawResult, activeAction);
    let validatedGeneratedWorkflow = null;
    if (result.outcome === 'completed'
        && activeAction.type === 'triage'
        && activeRun
        && this.store.getWorkItem(activeRun.workItemId)?.workflowSnapshot?.planningMode === 'ai') {
      const current = this.store.getWorkItem(activeRun.workItemId);
      const effective = result.contractPatch
        ? {
            ...current,
            goal: result.contractPatch.goal ?? current.goal,
            acceptanceCriteria: result.contractPatch.acceptanceCriteria ?? current.acceptanceCriteria,
          }
        : current;
      try {
        validatedGeneratedWorkflow = applyGeneratedPlan(effective, result.plan);
      } catch (error) {
        result.outcome = 'failed';
        result.error = error?.message || String(error);
      }
    }
    const detail = this.store.finalizeRun(
      runId,
      ownerBootId,
      leaseEpoch,
      result,
      ({ action, workItem }) => {
        if (result.outcome === 'waiting') {
          return {
            actionStatus: 'completed',
            workItemStatus: 'waiting',
            keepCurrentAction: true,
            eventType: 'action.waiting',
            eventData: { reason: result.waitingReason },
          };
        }

        if (result.outcome === 'retryable') {
          const retryable = action.attempt < action.maxAttempts;
          return {
            actionStatus: retryable ? 'ready' : 'failed',
            workItemStatus: retryable ? 'ready' : 'needs_attention',
            keepCurrentAction: true,
            eventType: retryable ? 'action.retry_scheduled' : 'action.retry_exhausted',
            eventData: {
              attempt: action.attempt,
              maxAttempts: action.maxAttempts,
              error: result.error,
            },
          };
        }

        if (result.outcome === 'failed') {
          return {
            actionStatus: 'failed',
            workItemStatus: 'needs_attention',
            keepCurrentAction: true,
            eventType: 'action.failed',
            eventData: { error: result.error },
          };
        }

        const contractPatch = action.type === 'triage' ? result.contractPatch : null;
        const effectiveWorkItem = contractPatch
          ? {
              ...workItem,
              goal: contractPatch.goal ?? workItem.goal,
              acceptanceCriteria: contractPatch.acceptanceCriteria ?? workItem.acceptanceCriteria,
              revision: workItem.revision + 1,
            }
          : workItem;
        const generatedWorkflow = action.type === 'triage'
          && workItem.workflowSnapshot?.planningMode === 'ai'
          ? validatedGeneratedWorkflow
          : null;
        const plannedWorkItem = generatedWorkflow
          ? { ...effectiveWorkItem, workflowSnapshot: generatedWorkflow }
          : effectiveWorkItem;
        const nextStep = getNextStep(plannedWorkItem, action.stageId || action.type, result);
        if (!nextStep) {
          return {
            actionStatus: 'completed',
            workItemStatus: 'done',
            contractPatch,
            workflowSnapshot: generatedWorkflow,
            eventType: 'work_item.completed',
            eventData: { summary: result.summary },
          };
        }

        const context = [...(action.context || []), contextEntry(action, result, activeRun)];
        return {
          actionStatus: 'completed',
          workItemStatus: 'ready',
          contractPatch,
          workflowSnapshot: generatedWorkflow,
          nextAction: actionForStage(nextStep, plannedWorkItem, context),
          eventType: 'action.completed',
          eventData: {
            nextActionType: nextStep.type,
            reviewDecision: result.reviewDecision,
          },
        };
      },
    );
    if (!detail) throw new Error('Run is stale, cancelled, expired, or already finished');
    return detail;
  }
}
