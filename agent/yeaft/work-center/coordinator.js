import { resolveMaxOutputTokens } from '../models.js';
import { resolveWorkItemModel, selectWorkItemVp } from './assignment.js';
import { normalizeContractPatch } from './completion-contract.js';
import { applyCoordinatorReplan } from './plan-mutation.js';

const COORDINATOR_MAX_REPLY_CHARS = 8_000;
const COORDINATOR_MAX_INSTRUCTION_CHARS = 8_000;
const COORDINATOR_MAX_OUTPUT_TOKENS = 8_192;
const COORDINATOR_MAX_SNAPSHOT_BYTES = 64 * 1024;
const COORDINATOR_RECOVERY_DECISION_ATTEMPTS = 2;
const COORDINATOR_MAX_CONVERSATION_MESSAGES = 20;
const COORDINATOR_MAX_ACTIONS = 64;
const COORDINATOR_MAX_WORK_ITEM_BYTES = 14 * 1024;
const COORDINATOR_MAX_ACTIONS_BYTES = 34 * 1024;
const COORDINATOR_MAX_CONVERSATION_BYTES = 10 * 1024;

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(String(value || ''), 'utf8');
  if (bytes.length <= maxBytes) return bytes.toString('utf8');
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function boundedJsonArray(values, maxBytes, options = {}) {
  const source = Array.isArray(values) ? values : [];
  const selected = [];
  const indexes = options.newestFirst
    ? [...source.keys()].reverse()
    : [...source.keys()];
  for (const index of indexes) {
    const candidate = options.newestFirst
      ? [source[index], ...selected]
      : [...selected, source[index]];
    if (jsonByteLength(candidate) <= maxBytes) selected.splice(0, selected.length, ...candidate);
  }
  return selected;
}

function boundedEvidence(value) {
  return (Array.isArray(value) ? value : []).slice(0, 3).map(item => ({
    kind: truncateUtf8(item?.kind, 32) || 'text',
    label: truncateUtf8(item?.label, 192),
    ...(item?.ref ? { ref: truncateUtf8(item.ref, 256) } : {}),
    ...(item?.status ? { status: truncateUtf8(item.status, 32) } : {}),
  })).filter(item => item.label);
}

function boundedAction(action, result, compact = false) {
  const brief = action?.brief && typeof action.brief === 'object' ? action.brief : null;
  return {
    stageId: truncateUtf8(action?.stageId, 256),
    type: truncateUtf8(action?.type, 64),
    status: truncateUtf8(action?.status, 64),
    generation: Math.max(1, Number(action?.generation) || 1),
    dependencies: (Array.isArray(action?.dependsOnStageIds) ? action.dependsOnStageIds : [])
      .slice(0, 8)
      .map(value => truncateUtf8(value, 128))
      .filter(Boolean),
    workspaceMode: truncateUtf8(action?.workspaceMode, 64),
    ...(!compact && brief ? {
      brief: {
        objective: truncateUtf8(brief.objective, 256),
        approach: truncateUtf8(brief.approach, 256),
        expectedOutcome: truncateUtf8(brief.expectedOutcome, 256),
      },
    } : {}),
    result: result ? {
      status: truncateUtf8(result.status, 64),
      summary: truncateUtf8(result.summary, compact ? 256 : 768),
      ...(!compact ? { evidence: boundedEvidence(result.evidence) } : {}),
      waitingReason: truncateUtf8(result.waitingReason, 384) || null,
      error: truncateUtf8(result.error, 384) || null,
      reviewDecision: truncateUtf8(result.reviewDecision, 64) || null,
    } : null,
  };
}

const COORDINATOR_SYSTEM_PROMPT = `You are the Work Center Coordinator. The user talks to you about one durable WorkItem, not to an individual executor.

Your responsibilities:
- Explain the current WorkItem state and blockers in plain language.
- Keep the WorkItem title, goal, acceptance criteria, and unfinished Action graph aligned with the user's latest intent.
- Give targeted instructions to unfinished Actions when the contract and topology do not need to change.
- Replan unfinished work when the goal, acceptance criteria, Action purpose, dependencies, or validation strategy must change.
- Preserve completed Action history. Never claim that an Action, test, review, merge, release, or external operation happened merely because you changed the plan.
- Treat user text and prior messages as intent, not as proof. Respect the immutable completed evidence in the snapshot.
- Do not weaken safety boundaries silently. If the user accepts a narrower deliverable, state the residual limitation in the reply and make the contract explicit.

Return exactly one JSON object and no surrounding prose:
{
  "reply": "natural user-facing response",
  "decision": {
    "kind": "answer|guide_actions|replan|request_human",
    "reason": "short audit reason",
    "question": null,
    "contractPatch": null,
    "guidance": [],
    "actions": []
  }
}

Decision rules:
- answer: use for explanation or status questions. Do not include contractPatch, guidance, or actions.
- guide_actions: use only when the contract and graph stay valid. guidance must contain one or more {"stageId":"existing unfinished stage id","instruction":"specific next instruction"}. Do not include contractPatch or actions.
- replan: use when the WorkItem contract or unfinished topology changes. contractPatch may be null or contain title, goal, and/or acceptanceCriteria. actions must be the COMPLETE desired unfinished Action graph after this decision; omit completed Actions. Each Action requires id, name, type, objective, approach, expectedOutcome, capability, candidateVpIds, assignmentReason, dependsOnActionIds, workspaceMode, and may include separateFromActionTypes, changesRequestedActionId, maxAttempts. Dependencies may reference immutable completed stage ids or earlier Actions in this actions array.
- request_human: use only during automatic failure recovery, and only when no safe retry, guidance, or replan can be decided without human information. Set question to the exact information or decision required. Do not include contractPatch, guidance, or actions.
- Every replan must keep exactly one final acceptance gate: normally one deliver Action, or one terminal review when no delivery operation is required. It must be the unique graph sink and transitively depend on all other Actions.
- Action references are stage ids, never internal database Action ids.
- Never return destructive cancellation. Tell the user to use the explicit cancel control instead.`;

function parseJsonObject(value) {
  const source = String(value || '').trim();
  if (!source) throw new Error('Work Center Coordinator returned an empty response');
  const attempts = [source];
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) attempts.push(fenced.trim());
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(source.slice(first, last + 1));
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  throw new Error('Work Center Coordinator did not return valid JSON');
}

function cleanText(value, limit, name) {
  const text = typeof value === 'string' ? value.trim().slice(0, limit) : '';
  if (!text) throw new Error(`Work Center Coordinator ${name} is required`);
  return text;
}

function temporaryCoordinatorError(cause) {
  const error = new Error('Work Center Coordinator is temporarily unavailable; automatic recovery will retry');
  error.coordinatorRetryable = true;
  error.cause = cause;
  return error;
}

function normalizeGuidance(value, detail) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new Error('Work Center Coordinator guidance requires between 1 and 8 targets');
  }
  const activeByStage = new Map((detail.actions || [])
    .filter(action => !['completed', 'superseded', 'cancelled'].includes(action.status))
    .map(action => [action.stageId, action]));
  const seen = new Set();
  return value.map(entry => {
    const stageId = typeof entry?.stageId === 'string' ? entry.stageId.trim() : '';
    if (!stageId || seen.has(stageId) || !activeByStage.has(stageId)) {
      throw new Error(`Work Center Coordinator guidance references an invalid unfinished Action: ${stageId || '(missing)'}`);
    }
    seen.add(stageId);
    return {
      stageId,
      instruction: cleanText(entry?.instruction, COORDINATOR_MAX_INSTRUCTION_CHARS, 'guidance instruction'),
    };
  });
}

function normalizeCoordinatorActionReferences(actions, detail) {
  const stageByReference = new Map();
  for (const action of detail.actions || []) {
    const stageId = typeof action?.stageId === 'string' ? action.stageId.trim() : '';
    if (!stageId) continue;
    stageByReference.set(stageId, stageId);
    if (typeof action.id === 'string' && action.id && !stageByReference.has(action.id)) {
      stageByReference.set(action.id, stageId);
    }
  }
  const normalizeReference = value => (
    typeof value === 'string' ? stageByReference.get(value.trim()) || value : value
  );
  return actions.map(action => ({
    ...structuredClone(action),
    ...(Array.isArray(action?.dependsOnActionIds) ? {
      dependsOnActionIds: action.dependsOnActionIds.map(normalizeReference),
    } : {}),
    ...(Object.hasOwn(action || {}, 'changesRequestedActionId') ? {
      changesRequestedActionId: normalizeReference(action.changesRequestedActionId),
    } : {}),
  }));
}

export function normalizeCoordinatorResponse(value, detail, options = {}) {
  const parsed = typeof value === 'string' ? parseJsonObject(value) : value;
  const reply = cleanText(parsed?.reply, COORDINATOR_MAX_REPLY_CHARS, 'reply');
  const source = parsed?.decision && typeof parsed.decision === 'object' && !Array.isArray(parsed.decision)
    ? parsed.decision
    : {};
  const allowedKinds = options.recovery === true
    ? ['guide_actions', 'replan', 'request_human']
    : ['answer', 'guide_actions', 'replan'];
  const kind = allowedKinds.includes(source.kind) ? source.kind : '';
  if (!kind) throw new Error('Work Center Coordinator decision kind is invalid');
  const reason = cleanText(source.reason, 2_000, 'decision reason');
  if (kind === 'answer') {
    return { reply, decision: { kind, reason, contractPatch: null, guidance: [], actions: [] } };
  }
  if (kind === 'guide_actions') {
    const guidance = normalizeGuidance(source.guidance, detail);
    if (options.recovery === true) {
      const failed = detail.actions?.find(action => (
        action.id === options.recoveryActionId && action.status === 'failed'
      ));
      if (!failed || guidance.length !== 1 || guidance[0].stageId !== failed.stageId) {
        throw new Error('Work Center Coordinator recovery guidance must target only the failed Action');
      }
    }
    return {
      reply,
      decision: {
        kind,
        reason,
        contractPatch: null,
        guidance,
        actions: [],
      },
    };
  }
  if (kind === 'request_human') {
    return {
      reply,
      decision: {
        kind,
        reason,
        question: cleanText(source.question, COORDINATOR_MAX_REPLY_CHARS, 'human question'),
        contractPatch: null,
        guidance: [],
        actions: [],
      },
    };
  }
  const contractPatch = normalizeContractPatch(source.contractPatch);
  if (!Array.isArray(source.actions) || source.actions.length < 1 || source.actions.length > 8) {
    throw new Error('Work Center Coordinator replan requires the complete unfinished Action graph');
  }
  return {
    reply,
    decision: {
      kind,
      reason,
      contractPatch,
      guidance: [],
      actions: normalizeCoordinatorActionReferences(source.actions, detail),
    },
  };
}

function coordinatorHistory(messages) {
  const history = (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role !== 'assistant' || message.status !== 'thinking')
    .filter(message => typeof message?.text === 'string' && message.text.trim())
    .slice(-COORDINATOR_MAX_CONVERSATION_MESSAGES)
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: truncateUtf8(message.role === 'legacy_instruction'
        ? `[Legacy global instruction already delivered to executors] ${message.text}`
        : message.text, 2_000),
    }));
  return boundedJsonArray(history, COORDINATOR_MAX_CONVERSATION_BYTES, { newestFirst: true });
}

function coordinatorSnapshotText(detail) {
  const snapshot = coordinatorSnapshot(detail);
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, 'utf8') > COORDINATOR_MAX_SNAPSHOT_BYTES) {
    throw new Error('WorkItem cannot be represented within the Coordinator snapshot budget');
  }
  return serialized;
}

function finalizedCriteria(detail, contractPatch) {
  const criteria = contractPatch?.acceptanceCriteria ?? detail.acceptanceCriteria ?? [];
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 24) {
    throw new Error('Work Center Coordinator replan requires between 1 and 24 acceptance criteria');
  }
  return criteria;
}

function coordinatorSnapshot(detail) {
  const runs = Array.isArray(detail.runs) ? detail.runs : [];
  const canonicalRunByAction = new Map();
  for (const action of detail.actions || []) {
    const candidates = runs
      .filter(run => run.actionId === action.id && run.status !== 'running')
      .sort((left, right) => Number(right.endedAt || right.startedAt) - Number(left.endedAt || left.startedAt));
    const canonical = action.resultRunId
      ? candidates.find(run => run.id === action.resultRunId)
      : candidates[0];
    if (canonical) canonicalRunByAction.set(action.id, canonical);
  }

  const acceptanceCriteria = boundedJsonArray(
    (Array.isArray(detail.acceptanceCriteria) ? detail.acceptanceCriteria : [])
      .slice(0, 24)
      .map(value => truncateUtf8(value, 768))
      .filter(Boolean),
    8 * 1024,
  );
  const workItem = {
    id: truncateUtf8(detail.id, 256),
    revision: detail.revision,
    planRevision: detail.planRevision,
    ledgerRevision: detail.ledgerRevision,
    status: truncateUtf8(detail.status, 64),
    title: truncateUtf8(detail.title, 1 * 1024),
    goal: truncateUtf8(detail.goal, 4 * 1024),
    acceptanceCriteria,
    workItemType: truncateUtf8(detail.workflowSnapshot?.workItemType, 256) || null,
  };
  if (jsonByteLength(workItem) > COORDINATOR_MAX_WORK_ITEM_BYTES) {
    throw new Error('WorkItem contract cannot be represented within the Coordinator snapshot budget');
  }

  const currentActions = (Array.isArray(detail.actions) ? detail.actions : [])
    .filter(action => !['superseded', 'cancelled'].includes(action.status));
  const unfinished = currentActions.filter(action => action.status !== 'completed');
  const completed = currentActions.filter(action => action.status === 'completed');
  const selected = [
    ...unfinished,
    ...completed.slice(-Math.max(0, COORDINATOR_MAX_ACTIONS - unfinished.length)),
  ].slice(0, COORDINATOR_MAX_ACTIONS);
  let projectedActions = selected.map(action => boundedAction(
    action,
    canonicalRunByAction.get(action.id),
    action.status === 'completed',
  ));
  let actions = boundedJsonArray(projectedActions, COORDINATOR_MAX_ACTIONS_BYTES);
  let includedActionIdentities = new Set(actions.map(action => `${action.stageId}:${action.generation}`));
  if (unfinished.some(action => !includedActionIdentities.has(`${action.stageId}:${action.generation}`))) {
    projectedActions = selected.map(action => boundedAction(
      action,
      canonicalRunByAction.get(action.id),
      true,
    ));
    actions = boundedJsonArray(projectedActions, COORDINATOR_MAX_ACTIONS_BYTES);
    includedActionIdentities = new Set(actions.map(action => `${action.stageId}:${action.generation}`));
  }
  if (unfinished.some(action => !includedActionIdentities.has(`${action.stageId}:${action.generation}`))) {
    throw new Error('Active Actions cannot be represented within the Coordinator snapshot budget');
  }

  return {
    workItem,
    actions,
    omittedCompletedActionCount: Math.max(0, completed.length - actions.filter(action => action.status === 'completed').length),
    conversation: coordinatorHistory(detail.messages),
  };
}

export class WorkItemCoordinator {
  constructor(options = {}) {
    this.store = options.store;
    this.runtimeProvider = options.runtimeProvider;
    this.policyProvider = typeof options.policyProvider === 'function' ? options.policyProvider : async () => ({});
    this.registry = options.registry;
    this.activeTurns = new Map();
    this.activeTasks = new Map();
    this.shuttingDown = false;
  }

  message(id, input = {}, options = {}) {
    if (this.shuttingDown) throw new Error('Work Center Coordinator is shutting down');
    const text = cleanText(input.text, COORDINATOR_MAX_REPLY_CHARS, 'message');
    const started = this.store.beginCoordinatorTurn(id, text, {
      revision: Number(input.revision),
      planRevision: Number(input.planRevision),
      ledgerRevision: Number(input.ledgerRevision),
      coordinatorRevision: Number(input.coordinatorRevision),
    });
    if (!started) throw new Error(`WorkItem not found: ${id}`);
    options.onUpdate?.('coordinator.turn_started', started.detail);
    return this.#scheduleTurn(started, { text, recovery: false, options });
  }

  recover(id, options = {}) {
    if (this.shuttingDown) throw new Error('Work Center Coordinator is shutting down');
    const detail = this.store.getWorkItemDetail(id);
    const hasExplicitIdentity = typeof options.actionId === 'string' && options.actionId;
    const action = hasExplicitIdentity
      ? detail?.actions?.find(candidate => (
          candidate.id === options.actionId
          && candidate.generation === options.actionGeneration
        ))
      : detail?.actions?.find(candidate => (
          candidate.id === detail.currentActionId && candidate.status === 'failed'
        ));
    if (!detail || ['done', 'cancelled'].includes(detail.status) || action?.status !== 'failed') return null;
    const started = this.store.beginCoordinatorTurn(id, '', {
      revision: detail.revision,
      planRevision: detail.planRevision,
      ledgerRevision: detail.ledgerRevision,
      coordinatorRevision: detail.coordinatorRevision,
    }, {
      recovery: {
        actionId: action.id,
        actionGeneration: action.generation,
        stageId: action.stageId,
      },
    });
    if (!started) return null;
    options.onUpdate?.('coordinator.recovery_started', started.detail);
    const recovery = started.detail.messages?.at(-1)?.recovery || {};
    const text = `Action stage "${action.stageId}" failed. Decide the next safe control transition. `
      + 'Failure is not a terminal WorkItem state: guide or replan executable work whenever possible. '
      + 'Request human input only when the snapshot lacks information required for a safe decision.';
    return this.#scheduleTurn(started, { text, recovery: true, options });
  }

  #scheduleTurn(started, { text, recovery, options }) {
    const abortController = new AbortController();
    this.activeTurns.set(started.turnId, abortController);
    const task = new Promise(resolve => setTimeout(resolve, 0))
      .then(() => this.#executeTurn(started, {
        text, recovery, options, abortController,
      }))
      .finally(() => {
        this.activeTurns.delete(started.turnId);
        this.activeTasks.delete(started.turnId);
      });
    this.activeTasks.set(started.turnId, task);
    return { detail: started.detail, task };
  }

  async #executeTurn(started, { text, recovery, options, abortController }) {
    try {
      let normalized = null;
      let mutation = null;
      let attemptCount = 0;
      let lastError = null;
      const snapshotText = coordinatorSnapshotText(started.detail);
      try {
        let runtime;
        let settings;
        try {
          runtime = await this.runtimeProvider();
          settings = await this.policyProvider();
        } catch (error) {
          throw temporaryCoordinatorError(error);
        }
        if (this.shuttingDown) throw new Error('Work Center Coordinator is shutting down');
        let vps;
        let resolved;
        try {
          vps = this.registry?.listVps?.() || [];
          const assignment = selectWorkItemVp({
            policy: { mode: 'pool', candidateVpIds: vps.map(vp => vp.id), capability: 'triage' },
            stageType: 'triage',
            vps,
            priorRuns: started.detail.runs || [],
          });
          const coordinatorPolicy = settings?.coordinatorModelPolicy || {
            ...(settings?.modelPolicy || {}),
            effort: settings?.actionModelPolicies?.triage?.effort || settings?.modelPolicy?.effort || 'high',
          };
          resolved = resolveWorkItemModel(runtime.config, assignment.vp, coordinatorPolicy);
        } catch (error) {
          throw temporaryCoordinatorError(error);
        }
        const maxAttempts = recovery ? COORDINATOR_RECOVERY_DECISION_ATTEMPTS : 1;
        for (let index = 0; index < maxAttempts; index += 1) {
          attemptCount = index + 1;
          mutation = null;
          const correction = lastError
            ? `\n\nYour previous decision was rejected by the deterministic validator:\n${String(lastError.message || lastError).slice(0, 2_000)}\nReturn a corrected complete JSON decision.`
            : '';
          try {
            let result;
            try {
              result = await Promise.race([
                runtime.adapter.call({
                  model: resolved.model,
                  system: COORDINATOR_SYSTEM_PROMPT,
                  messages: [{
                    role: 'user',
                    content: `Current WorkItem snapshot:\n${snapshotText}\n\n${recovery ? 'Automatic failure recovery trigger' : 'Latest user message'}:\n${text}${correction}`,
                  }],
                  maxTokens: Math.min(
                    resolveMaxOutputTokens(resolved.model, runtime.config),
                    COORDINATOR_MAX_OUTPUT_TOKENS,
                  ),
                  effort: resolved.effort,
                  effortSource: resolved.source,
                  effortContext: { scenario: 'work-center-coordinator' },
                  signal: abortController.signal,
                }),
                new Promise((_, reject) => {
                  abortController.signal.addEventListener('abort', () => {
                    reject(new Error('Work Center Coordinator was interrupted'));
                  }, { once: true });
                }),
              ]);
            } catch (error) {
              if (abortController.signal.aborted || this.shuttingDown) throw error;
              throw temporaryCoordinatorError(error);
            }
            normalized = normalizeCoordinatorResponse(result?.text, started.detail, {
              recovery,
              recoveryActionId: started.fence.recovery?.actionId || null,
            });
            if (normalized.decision.kind === 'replan') {
              finalizedCriteria(started.detail, normalized.decision.contractPatch);
              mutation = applyCoordinatorReplan({
                workItem: {
                  ...started.detail,
                  ...(normalized.decision.contractPatch || {}),
                },
                actions: started.detail.actions || [],
                proposal: {
                  proposalId: `coordinator:${started.turnId}`,
                  basePlanRevision: started.detail.planRevision,
                  reason: normalized.decision.reason,
                  actions: normalized.decision.actions,
                },
                availableVpIds: vps.map(vp => vp.id),
              });
            }
            lastError = null;
            break;
          } catch (error) {
            normalized = null;
            if (abortController.signal.aborted || this.shuttingDown || error?.coordinatorRetryable) {
              throw error;
            }
            lastError = error;
          }
        }
      } catch (error) {
        lastError = error;
      }
      if (abortController.signal.aborted || this.shuttingDown) {
        throw lastError || new Error('Work Center Coordinator was interrupted');
      }
      if (!normalized) {
        if (!recovery || lastError?.coordinatorRetryable) {
          throw lastError || new Error('Work Center Coordinator did not produce a decision');
        }
        normalized = {
          reply: 'Automatic recovery could not choose a safe executable next step. Human input is required.',
          decision: {
            kind: 'request_human',
            reason: 'Automatic recovery exhausted its bounded decision attempts',
            question: 'Review the failed Action and provide the missing decision or constraint needed to retry or replan it safely.',
            contractPatch: null,
            guidance: [],
            actions: [],
          },
        };
      }
      const detail = this.store.completeCoordinatorTurn(started.turnId, {
        reply: normalized.reply,
        decision: normalized.decision,
        mutation,
        attemptCount,
      }, started.fence);
      if (!detail) throw new Error('Work Center Coordinator turn is stale or already completed');
      options.onUpdate?.(recovery ? 'coordinator.recovery_completed' : 'coordinator.turn_completed', detail);
      return detail;
    } catch (error) {
      const detail = this.store.failCoordinatorTurn(started.turnId, error, started.fence);
      if (detail) {
        options.onUpdate?.('coordinator.turn_failed', detail);
        return detail;
      }
      throw error;
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    for (const controller of this.activeTurns.values()) controller.abort('work_center_coordinator_shutdown');
    const tasks = [...this.activeTasks.values()];
    if (tasks.length > 0) await Promise.allSettled(tasks);
    this.activeTurns.clear();
    this.activeTasks.clear();
  }
}
