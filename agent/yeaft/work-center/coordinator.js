import { resolveMaxOutputTokens } from '../models.js';
import { resolveWorkItemModel, selectWorkItemVp } from './assignment.js';
import { normalizeContractPatch } from './completion-contract.js';
import { applyCoordinatorReplan } from './plan-mutation.js';

const COORDINATOR_MAX_REPLY_CHARS = 8_000;
const COORDINATOR_MAX_INSTRUCTION_CHARS = 8_000;
const COORDINATOR_MAX_OUTPUT_TOKENS = 8_192;
const COORDINATOR_MAX_SNAPSHOT_BYTES = 64 * 1024;

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
    "kind": "answer|guide_actions|replan",
    "reason": "short audit reason",
    "contractPatch": null,
    "guidance": [],
    "actions": []
  }
}

Decision rules:
- answer: use for explanation or status questions. Do not include contractPatch, guidance, or actions.
- guide_actions: use only when the contract and graph stay valid. guidance must contain one or more {"stageId":"existing unfinished stage id","instruction":"specific next instruction"}. Do not include contractPatch or actions.
- replan: use when the WorkItem contract or unfinished topology changes. contractPatch may be null or contain title, goal, and/or acceptanceCriteria. actions must be the COMPLETE desired unfinished Action graph after this decision; omit completed Actions. Each Action requires id, name, type, objective, approach, expectedOutcome, capability, candidateVpIds, assignmentReason, dependsOnActionIds, workspaceMode, and may include separateFromActionTypes, changesRequestedActionId, maxAttempts. Dependencies may reference immutable completed stage ids or earlier Actions in this actions array.
- Every replan must keep exactly one final acceptance gate: normally one deliver Action, or one terminal review when no delivery operation is required. It must be the unique graph sink and transitively depend on all other Actions.
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

export function normalizeCoordinatorResponse(value, detail) {
  const parsed = typeof value === 'string' ? parseJsonObject(value) : value;
  const reply = cleanText(parsed?.reply, COORDINATOR_MAX_REPLY_CHARS, 'reply');
  const source = parsed?.decision && typeof parsed.decision === 'object' && !Array.isArray(parsed.decision)
    ? parsed.decision
    : {};
  const kind = ['answer', 'guide_actions', 'replan'].includes(source.kind) ? source.kind : '';
  if (!kind) throw new Error('Work Center Coordinator decision kind is invalid');
  const reason = cleanText(source.reason, 2_000, 'decision reason');
  if (kind === 'answer') {
    return { reply, decision: { kind, reason, contractPatch: null, guidance: [], actions: [] } };
  }
  if (kind === 'guide_actions') {
    return {
      reply,
      decision: {
        kind,
        reason,
        contractPatch: null,
        guidance: normalizeGuidance(source.guidance, detail),
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
      actions: structuredClone(source.actions),
    },
  };
}

function coordinatorHistory(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role !== 'assistant' || message.status !== 'thinking')
    .filter(message => typeof message?.text === 'string' && message.text.trim())
    .slice(-20)
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: message.role === 'legacy_instruction'
        ? `[Legacy global instruction already delivered to executors] ${message.text.slice(0, COORDINATOR_MAX_REPLY_CHARS)}`
        : message.text.slice(0, COORDINATOR_MAX_REPLY_CHARS),
    }));
}

function coordinatorSnapshotText(detail) {
  const snapshot = JSON.stringify(coordinatorSnapshot(detail));
  if (Buffer.byteLength(snapshot, 'utf8') > COORDINATOR_MAX_SNAPSHOT_BYTES) {
    throw new Error('WorkItem is too large for a safe Coordinator turn; compact the Action history first');
  }
  return snapshot;
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
  return {
    workItem: {
      id: detail.id,
      revision: detail.revision,
      planRevision: detail.planRevision,
      ledgerRevision: detail.ledgerRevision,
      status: detail.status,
      title: detail.title,
      goal: detail.goal,
      acceptanceCriteria: detail.acceptanceCriteria || [],
      workItemType: detail.workflowSnapshot?.workItemType || null,
    },
    actions: (detail.actions || [])
      .filter(action => !['superseded', 'cancelled'].includes(action.status))
      .map(action => {
        const result = canonicalRunByAction.get(action.id);
        return {
          id: action.id,
          stageId: action.stageId,
          type: action.type,
          status: action.status,
          generation: action.generation,
          dependencies: action.dependsOnStageIds || [],
          workspaceMode: action.workspaceMode,
          brief: action.brief || null,
          result: result ? {
            status: result.status,
            summary: result.summary || '',
            evidence: (result.evidence || []).slice(0, 20),
            waitingReason: result.waitingReason || null,
            error: result.error || null,
            reviewDecision: result.reviewDecision || null,
          } : null,
        };
      }),
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

    const abortController = new AbortController();
    this.activeTurns.set(started.turnId, abortController);
    const task = new Promise(resolve => setTimeout(resolve, 0)).then(async () => {
      try {
        const runtime = await this.runtimeProvider();
        if (this.shuttingDown) throw new Error('Work Center Coordinator is shutting down');
        const settings = await this.policyProvider();
        const vps = this.registry?.listVps?.() || [];
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
        const resolved = resolveWorkItemModel(runtime.config, assignment.vp, coordinatorPolicy);
        const result = await Promise.race([
          runtime.adapter.call({
          model: resolved.model,
          system: COORDINATOR_SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: `Current WorkItem snapshot:\n${coordinatorSnapshotText(started.detail)}\n\nLatest user message:\n${text}`,
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
        const normalized = normalizeCoordinatorResponse(result?.text, started.detail);
        if (normalized.decision.kind === 'replan') {
          finalizedCriteria(started.detail, normalized.decision.contractPatch);
        }
        const mutation = normalized.decision.kind === 'replan'
          ? applyCoordinatorReplan({
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
            })
          : null;
        const detail = this.store.completeCoordinatorTurn(started.turnId, {
          reply: normalized.reply,
          decision: normalized.decision,
          mutation,
        }, started.fence);
        if (!detail) throw new Error('Work Center Coordinator turn is stale or already completed');
        options.onUpdate?.('coordinator.turn_completed', detail);
        return detail;
      } catch (error) {
        const detail = this.store.failCoordinatorTurn(started.turnId, error, started.fence);
        if (detail) {
          options.onUpdate?.('coordinator.turn_failed', detail);
          return detail;
        }
        throw error;
      } finally {
        this.activeTurns.delete(started.turnId);
        this.activeTasks.delete(started.turnId);
      }
    });
    this.activeTasks.set(started.turnId, task);
    return { detail: started.detail, task };
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
