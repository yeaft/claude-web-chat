import { actionInstruction, getNextStep, initialActionFor, RUN_OUTCOMES } from './workflow.js';
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

function contextEntry(action, result) {
  return {
    type: action.type,
    role: action.requiredRole,
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
    const firstAction = input.start !== false ? initialActionFor(draft) : null;
    return this.store.createWorkItem(draft, firstAction);
  }

  start(id) {
    const detail = this.store.startWorkItemAtomic(id, initialActionFor);
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

  retry(id, input = {}) {
    const answer = typeof input.answer === 'string' ? input.answer.trim().slice(0, 8_000) : '';
    const detail = this.store.retryWorkItemAtomic(id, (workItem, previous, previousRun) => {
      if (workItem.status === 'waiting' && !answer) {
        throw new Error('answer is required to resume a waiting WorkItem');
      }
      const step = previous
        ? { type: previous.type, requiredRole: previous.requiredRole }
        : initialActionFor(workItem);
      const context = Array.isArray(previous?.context) ? [...previous.context] : [];
      if (previousRun) {
        context.push({
          type: previous.type,
          role: previous.requiredRole,
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
        const nextStep = getNextStep(workItem.workflowTemplate, action.type, result);
        if (!nextStep) {
          return {
            actionStatus: 'completed',
            workItemStatus: 'done',
            contractPatch,
            eventType: 'work_item.completed',
            eventData: { summary: result.summary },
          };
        }

        const context = [...(action.context || []), contextEntry(action, result)];
        return {
          actionStatus: 'completed',
          workItemStatus: 'ready',
          contractPatch,
          nextAction: {
            ...nextStep,
            context,
            instruction: actionInstruction(nextStep, effectiveWorkItem, context),
            maxAttempts: 2,
          },
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
