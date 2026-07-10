import { actionInstruction, getNextStep, initialActionFor, RUN_OUTCOMES } from './workflow.js';

function assertTerminalResult(result) {
  if (!result || !RUN_OUTCOMES.includes(result.outcome)) {
    throw new Error(`Invalid Work Center outcome: ${result?.outcome || '(missing)'}`);
  }
  if (result.outcome === 'waiting' && !result.waitingReason) {
    throw new Error('waiting outcome requires waitingReason');
  }
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
    const startImmediately = input.start !== false;
    const firstAction = startImmediately ? initialActionFor(draft) : null;
    return this.store.createWorkItem(draft, firstAction);
  }

  start(id) {
    const current = this.store.getWorkItem(id);
    if (!current) throw new Error(`WorkItem not found: ${id}`);
    if (current.status === 'done' || current.status === 'cancelled') {
      throw new Error(`Cannot start WorkItem in ${current.status}`);
    }
    if (current.currentActionId && this.store.getAction(current.currentActionId)?.status === 'ready') {
      this.store.setWorkItemState(id, 'ready', { currentActionId: current.currentActionId, currentRunId: null });
      return this.store.getWorkItemDetail(id);
    }
    const action = this.store.createNextAction(id, initialActionFor(current));
    this.store.setWorkItemState(id, 'ready', { currentActionId: action.id, currentRunId: null });
    this.store.appendEvent(id, 'work_item.started', {}, { actionId: action.id });
    return this.store.getWorkItemDetail(id);
  }

  update(id, patch) {
    const updated = this.store.updateWorkItemFields(id, patch);
    if (!updated) throw new Error(`WorkItem not found: ${id}`);
    if (updated.contractChanged) {
      this.store.supersedeOpenActions(id);
      const action = this.store.createNextAction(id, initialActionFor(updated.workItem));
      this.store.setWorkItemState(id, 'ready', { currentActionId: action.id, currentRunId: null });
      this.store.appendEvent(id, 'workflow.retriaged', { revision: updated.workItem.revision }, { actionId: action.id });
    }
    return this.store.getWorkItemDetail(id);
  }

  cancel(id) {
    const workItem = this.store.getWorkItem(id);
    if (!workItem) throw new Error(`WorkItem not found: ${id}`);
    if (workItem.status === 'done') throw new Error('Completed WorkItem cannot be cancelled');
    this.store.supersedeOpenActions(id);
    this.store.setWorkItemState(id, 'cancelled', { currentActionId: null, currentRunId: null });
    this.store.appendEvent(id, 'work_item.cancelled');
    return this.store.getWorkItemDetail(id);
  }

  retry(id) {
    const workItem = this.store.getWorkItem(id);
    if (!workItem) throw new Error(`WorkItem not found: ${id}`);
    if (!['waiting', 'needs_attention'].includes(workItem.status)) {
      throw new Error(`WorkItem in ${workItem.status} does not need retry`);
    }
    const previous = workItem.currentActionId ? this.store.getAction(workItem.currentActionId) : null;
    const step = previous
      ? { type: previous.type, requiredRole: previous.requiredRole }
      : initialActionFor(workItem);
    const action = this.store.createNextAction(id, {
      ...step,
      instruction: previous?.instruction || actionInstruction(step, workItem),
      maxAttempts: previous?.maxAttempts || 2,
    });
    this.store.setWorkItemState(id, 'ready', { currentActionId: action.id, currentRunId: null });
    this.store.appendEvent(id, 'work_item.retried', {}, { actionId: action.id });
    return this.store.getWorkItemDetail(id);
  }

  submit(runId, ownerBootId, leaseEpoch, result) {
    assertTerminalResult(result);
    const finished = this.store.finishRun(runId, ownerBootId, leaseEpoch, result);
    if (!finished) throw new Error('Run is stale, cancelled, or already finished');
    const { run, action, workItem } = finished;

    if (result.outcome === 'waiting') {
      // The Run is terminal. Keep the Action as historical completion of this
      // attempt; resuming always creates a new ready Action/Run instead of
      // pretending the old Run is still executable.
      this.store.setActionState(action.id, 'completed');
      this.store.setWorkItemState(workItem.id, 'waiting', { currentActionId: action.id, currentRunId: null });
      this.store.appendEvent(workItem.id, 'action.waiting', { reason: result.waitingReason }, { actionId: action.id, runId: run.id });
      return this.store.getWorkItemDetail(workItem.id);
    }

    if (result.outcome === 'retryable') {
      const retryable = action.attempt < action.maxAttempts;
      this.store.setActionState(action.id, retryable ? 'ready' : 'failed');
      this.store.setWorkItemState(workItem.id, retryable ? 'ready' : 'needs_attention', { currentActionId: action.id, currentRunId: null });
      this.store.appendEvent(workItem.id, retryable ? 'action.retry_scheduled' : 'action.retry_exhausted', {
        attempt: action.attempt,
        maxAttempts: action.maxAttempts,
        error: result.error || null,
      }, { actionId: action.id, runId: run.id });
      return this.store.getWorkItemDetail(workItem.id);
    }

    if (result.outcome === 'failed') {
      this.store.setActionState(action.id, 'failed');
      this.store.setWorkItemState(workItem.id, 'needs_attention', { currentActionId: action.id, currentRunId: null });
      this.store.appendEvent(workItem.id, 'action.failed', { error: result.error || null }, { actionId: action.id, runId: run.id });
      return this.store.getWorkItemDetail(workItem.id);
    }

    this.store.setActionState(action.id, 'completed');
    const nextStep = getNextStep(workItem.workflowTemplate, action.type, result);
    if (!nextStep) {
      this.store.setWorkItemState(workItem.id, 'done', { currentActionId: null, currentRunId: null });
      this.store.appendEvent(workItem.id, 'work_item.completed', { summary: result.summary || '' }, { actionId: action.id, runId: run.id });
      return this.store.getWorkItemDetail(workItem.id);
    }

    const nextAction = this.store.createNextAction(workItem.id, {
      ...nextStep,
      instruction: actionInstruction(nextStep, workItem),
      maxAttempts: 2,
    });
    this.store.setWorkItemState(workItem.id, 'ready', { currentActionId: nextAction.id, currentRunId: null });
    this.store.appendEvent(workItem.id, 'action.completed', {
      nextActionType: nextStep.type,
      reviewDecision: result.reviewDecision || null,
    }, { actionId: action.id, runId: run.id });
    return this.store.getWorkItemDetail(workItem.id);
  }
}
