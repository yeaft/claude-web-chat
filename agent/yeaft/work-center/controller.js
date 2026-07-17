import {
  actionForStage,
  actionInstruction,
  applyGeneratedPlan,
  getNextStep,
  initialActionFor,
  RUN_OUTCOMES,
} from './workflow.js';
import { renderSessionContextSnapshot } from './session-context.js';
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

function normalizeAcceptanceChecks(value, criteria) {
  if (!Array.isArray(value) || value.length !== criteria.length) return null;
  const checks = value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const criterion = typeof raw.criterion === 'string' ? raw.criterion.trim() : '';
    const status = ['passed', 'deferred', 'not_applicable'].includes(raw.status) ? raw.status : '';
    const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim().slice(0, 1_000) : '';
    if (criterion !== criteria[index] || !status || !evidence) return null;
    return { criterion, status, evidence };
  });
  return checks.every(Boolean) ? checks : null;
}

function validateCompletedResult(result, action, workItem) {
  if (result.outcome !== 'completed') return;
  if (result.evidence.length === 0) {
    result.outcome = 'failed';
    result.error = 'Completed Action requires at least one concrete evidence item';
    return;
  }
  const criteria = result.contractPatch?.acceptanceCriteria
    ?? (Array.isArray(workItem.acceptanceCriteria) ? workItem.acceptanceCriteria : []);
  const checks = normalizeAcceptanceChecks(result.acceptanceChecks, criteria);
  if (!checks) {
    result.outcome = 'failed';
    result.error = 'Completed Action requires one ordered acceptance check with evidence for every acceptance criterion';
    return;
  }
  const mustVerify = action.type === 'test'
    || action.type === 'deliver'
    || (action.type === 'review' && result.reviewDecision === 'approved');
  if (mustVerify && checks.some(check => check.status !== 'passed')) {
    result.outcome = 'failed';
    result.error = `${action.type} Action requires every acceptance check to pass`;
  }
}

function normalizeTerminalResult(result, action) {
  if (!result || !RUN_OUTCOMES.includes(result.outcome)) {
    throw new Error(`Invalid Work Center outcome: ${result?.outcome || '(missing)'}`);
  }
  const normalized = {
    outcome: result.outcome,
    response: String(result.response || ''),
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
    llmRequestCount: Math.max(0, Number(result.llmRequestCount) || 0),
    inputTokens: Math.max(0, Number(result.inputTokens) || 0),
    outputTokens: Math.max(0, Number(result.outputTokens) || 0),
    cacheReadTokens: Math.max(0, Number(result.cacheReadTokens) || 0),
    cacheWriteTokens: Math.max(0, Number(result.cacheWriteTokens) || 0),
    totalTokens: Math.max(0, Number(result.totalTokens) || 0),
    acceptanceChecks: Array.isArray(result.acceptanceChecks) ? result.acceptanceChecks : [],
    checkpoint: result.checkpoint && typeof result.checkpoint === 'object'
      ? result.checkpoint : null,
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
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
    };
    let firstAction = input.start !== false ? initialActionFor(draft) : null;
    if (firstAction) {
      firstAction = {
        ...firstAction,
        instruction: actionInstruction(firstAction, draft, [], renderSessionContextSnapshot(draft.sessionContext)),
      };
    }
    if (firstAction && draft.reuseMemory !== false) {
      const context = this.store.getReusableContext(draft.workDir, draft.id);
      firstAction = {
        ...firstAction,
        context,
        instruction: actionInstruction(firstAction, draft, context, renderSessionContextSnapshot(draft.sessionContext)),
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
        instruction: actionInstruction(action, workItem, context, renderSessionContextSnapshot(workItem.sessionContext)),
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
    const addedAttachmentCount = Math.max(0, Number(input.addedAttachmentCount) || 0);
    if (!guidance && addedAttachmentCount === 0) throw new Error('guidance or attachments are required');
    const guidanceSummary = guidance || `The user added ${addedAttachmentCount} attachment(s) as additional context for this Action.`;
    const expected = {
      actionId: typeof input.actionId === 'string' ? input.actionId : '',
      revision: Number(input.revision),
    };
    if (!expected.actionId || !Number.isInteger(expected.revision)) {
      throw new Error('actionId and revision are required for guidance');
    }
    const detail = this.store.addActionGuidance(id, guidanceSummary, expected, (workItem, previous) => {
      const context = [...(previous.context || []), {
        type: 'guidance',
        role: 'user',
        summary: guidanceSummary,
        evidence: [],
      }];
      const step = {
        type: previous.type,
        stageId: previous.stageId || previous.type,
        assignmentPolicy: previous.assignmentPolicy,
        modelPolicy: previous.modelPolicy,
        requiredRole: previous.requiredRole,
        brief: previous.brief,
      };
      return {
        ...step,
        context,
        instruction: actionInstruction(step, workItem, context, renderSessionContextSnapshot(workItem.sessionContext)),
        maxAttempts: previous.maxAttempts || 2,
      };
    }, input.attachments, input.addedAttachments);
    if (!detail) throw new Error(`WorkItem not found: ${id}`);
    return detail;
  }

  input(id, input = {}) {
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, 8_000) : '';
    const addedAttachmentCount = Math.max(0, Number(input.addedAttachmentCount) || 0);
    if (!text && addedAttachmentCount === 0) throw new Error('Action input or attachments are required');
    const workItem = this.store.getWorkItem(id);
    if (!workItem) throw new Error(`WorkItem not found: ${id}`);
    if (['ready', 'running'].includes(workItem.status)) {
      if (workItem.currentActionId !== input.actionId || workItem.revision !== input.revision) {
        throw new Error('Action changed before input was applied; refresh and try again');
      }
      return this.guide(id, {
        guidance: text,
        actionId: input.actionId,
        revision: input.revision,
        addedAttachmentCount,
        addedAttachments: input.addedAttachments,
        attachments: input.attachments,
      });
    }
    if (!['waiting', 'needs_attention'].includes(workItem.status)) {
      throw new Error(`WorkItem in ${workItem.status} cannot accept Action input`);
    }
    if (workItem.currentActionId !== input.actionId || workItem.revision !== input.revision) {
      throw new Error('Action changed before input was applied; refresh and try again');
    }
    return this.retry(id, {
      answer: text,
      addedAttachmentCount,
      expected: { actionId: input.actionId, revision: input.revision },
      attachments: input.attachments,
      inputEvent: {
        text: text || `The user added ${addedAttachmentCount} attachment(s) as additional context for this Action.`,
        attachments: input.addedAttachments,
      },
    });
  }

  retry(id, input = {}) {
    const answer = typeof input.answer === 'string' ? input.answer.trim().slice(0, 8_000) : '';
    const addedAttachmentCount = Math.max(0, Number(input.addedAttachmentCount) || 0);
    const detail = this.store.retryWorkItemAtomic(id, (workItem, previous, previousRun) => {
      if (workItem.status === 'waiting' && !answer && addedAttachmentCount === 0) {
        throw new Error('answer or attachments are required to resume a waiting WorkItem');
      }
      const step = previous
        ? {
            type: previous.type,
            stageId: previous.stageId || previous.type,
            assignmentPolicy: previous.assignmentPolicy,
            modelPolicy: previous.modelPolicy,
            requiredRole: previous.requiredRole,
            dependsOnStageIds: previous.dependsOnStageIds,
            workspaceMode: previous.workspaceMode,
            changesRequestedStageId: previous.changesRequestedStageId,
            brief: previous.brief,
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
          answer: answer || (addedAttachmentCount > 0
            ? `The user added ${addedAttachmentCount} attachment(s) as additional context for this Action.`
            : null),
        });
      }
      return {
        ...step,
        context,
        instruction: actionInstruction(step, workItem, context, renderSessionContextSnapshot(workItem.sessionContext)),
        maxAttempts: previous?.maxAttempts || 2,
      };
    }, {
      expected: input.expected || null,
      attachments: input.attachments,
      inputEvent: input.inputEvent || null,
    });
    if (!detail) throw new Error(`WorkItem not found: ${id}`);
    return detail;
  }

  submit(runId, ownerBootId, leaseEpoch, rawResult) {
    const activeRun = this.store.getRun(runId);
    const activeAction = activeRun ? this.store.getAction(activeRun.actionId) : null;
    if (!activeRun || !activeAction) throw new Error('Run is stale, cancelled, or already finished');
    const activeWorkItem = this.store.getWorkItem(activeRun.workItemId);
    const result = normalizeTerminalResult(rawResult, activeAction);
    validateCompletedResult(result, activeAction, activeWorkItem);
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
            graphAdvance: workItem.workflowSnapshot?.executionMode === 'graph',
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
            graphAdvance: workItem.workflowSnapshot?.executionMode === 'graph',
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
            graphAdvance: workItem.workflowSnapshot?.executionMode === 'graph',
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
        const context = [...(action.context || []), contextEntry(action, result, activeRun)];
        if (plannedWorkItem.workflowSnapshot?.executionMode === 'graph') {
          if (action.type === 'review' && result.reviewDecision === 'changes_requested') {
            const targetStage = plannedWorkItem.workflowSnapshot.stages
              .find(stage => stage.id === action.changesRequestedStageId);
            if (!targetStage) throw new Error('Work Center review return target is missing');
            return {
              actionStatus: 'completed', workItemStatus: 'ready', graphAdvance: true,
              graphResetStageId: action.changesRequestedStageId,
              graphResetAction: actionForStage(targetStage, plannedWorkItem, context),
              eventType: 'review.changes_requested',
              eventData: { targetStageId: action.changesRequestedStageId },
            };
          }
          const nextActions = generatedWorkflow
            ? generatedWorkflow.stages.slice(1).map(stage => actionForStage(stage, plannedWorkItem, context))
            : [];
          return {
            actionStatus: 'completed',
            workItemStatus: nextActions.length > 0 ? 'ready' : 'running',
            contractPatch,
            workflowSnapshot: generatedWorkflow,
            nextActions,
            graphAdvance: true,
            eventType: 'action.completed',
            eventData: { nextActionCount: nextActions.length, reviewDecision: result.reviewDecision },
          };
        }

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
