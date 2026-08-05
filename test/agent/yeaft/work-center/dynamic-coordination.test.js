import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DYNAMIC_COORDINATION_MODE,
  DYNAMIC_EXECUTION_SCHEMA_VERSION,
  isDynamicWorkItem,
  normalizeDynamicCompletion,
  prepareDynamicActionMutation,
  resolveDynamicActionPolicySnapshot,
} from '../../../../agent/yeaft/work-center/dynamic-coordination.js';
import { normalizeCoordinatorResponse } from '../../../../agent/yeaft/work-center/coordinator.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { buildMainlineContextSnapshot } from '../../../../agent/yeaft/work-center/mainline-projection.js';

function workItem(overrides = {}) {
  return {
    id: 'work-item-1',
    coordinationMode: DYNAMIC_COORDINATION_MODE,
    executionSchemaVersion: DYNAMIC_EXECUTION_SCHEMA_VERSION,
    title: 'Ship a durable dynamic loop',
    goal: 'Let the Coordinator create only currently justified Actions',
    acceptanceCriteria: ['Actions are dynamic', 'Completion is evidence-backed'],
    workflowSnapshot: resolveDynamicActionPolicySnapshot({}, 'software-change'),
    ...overrides,
  };
}

function completedAction(id = 'research-1') {
  return {
    id,
    workItemId: 'work-item-1',
    type: 'research',
    status: 'completed',
    resultRunId: `run-${id}`,
  };
}

describe('Work Center dynamic coordination contract', () => {
  let tempDir;
  let store;

  afterEach(() => {
    try { store?.close(); } catch {}
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    store = null;
    tempDir = null;
  });

  it('builds a policy snapshot without a workflow graph or prebuilt stages', () => {
    const snapshot = resolveDynamicActionPolicySnapshot({}, 'software-change');
    expect(snapshot).toMatchObject({
      planningMode: 'coordinator',
      executionMode: 'dynamic',
      workItemType: 'software-change',
    });
    expect(snapshot).not.toHaveProperty('stages');
    expect(snapshot).not.toHaveProperty('dependsOnStageIds');
    expect(snapshot.actionTemplates).toContainEqual({ type: 'implement' });
    expect(snapshot.actionTemplates).not.toContainEqual({ type: 'triage' });
    expect(isDynamicWorkItem(workItem())).toBe(true);
  });

  it('normalizes only the next runnable Actions and keeps sources as non-scheduling references', () => {
    const source = completedAction();
    const mutation = prepareDynamicActionMutation({
      workItem: workItem(),
      actions: [source],
      availableVpIds: ['linus', 'martin'],
      decision: {
        workItemType: 'software-change',
        contractPatch: null,
        supersedeActionIds: [],
        actions: [{
          type: 'implement',
          objective: 'Implement the Coordinator-driven Action dispatch path.',
          approach: 'Modify the existing Work Center store and add focused regression tests.',
          expectedOutcome: 'A runnable implementation Action with verified tests.',
          capability: 'implement',
          candidateVpIds: ['linus'],
          assignmentReason: 'Linus owns implementation work.',
          sourceActionIds: [source.id],
          workspaceMode: 'shared',
        }],
      },
    });

    expect(mutation.createdActions).toHaveLength(1);
    expect(mutation.createdActions[0]).toMatchObject({
      type: 'implement',
      sourceActionIds: [source.id],
      dependsOnStageIds: [],
      changesRequestedStageId: null,
      workspaceMode: 'shared',
    });
    expect(mutation.createdActions[0].id).toBe(mutation.createdActions[0].stageId);
    expect(mutation.createdActions[0].instruction).toContain('Implement the Coordinator-driven Action dispatch path.');

    const isolatedSource = { ...source, id: 'isolated-source', workspaceMode: 'isolated-write' };
    const integration = prepareDynamicActionMutation({
      workItem: workItem(), actions: [isolatedSource], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'integrate', objective: 'Integrate the completed isolated implementation.',
          approach: 'Apply the canonical isolated commit to the Work Item workspace.',
          expectedOutcome: 'The isolated implementation is present in the main workspace.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns integration.',
          sourceActionIds: [isolatedSource.id], workspaceMode: 'integrate',
        }],
      },
    });
    expect(integration.createdActions[0]).toMatchObject({
      workspaceMode: 'integrate', sourceActionIds: [isolatedSource.id], dependsOnStageIds: [],
    });

    const action = mutation.createdActions[0];
    const { contextSnapshot: snapshot } = buildMainlineContextSnapshot({
      ...workItem(),
      actions: [{ ...source, stageId: source.id, generation: 1, specHash: 'source-hash' }, action],
      runs: [{
        id: source.resultRunId, actionId: source.id, status: 'completed', summary: 'Research complete',
        evidence: [{ kind: 'text', label: 'research evidence' }], endedAt: 10,
      }],
      planRevision: 1,
      ledgerRevision: 1,
      planConflicts: [],
    }, action);
    expect(snapshot).not.toHaveProperty('graph');
    expect(snapshot.actionJournal.entries).toHaveLength(2);
    expect(snapshot.action.spec).toEqual(expect.objectContaining({ sourceActionIds: [source.id] }));
    expect(snapshot.sourceResults).toEqual([
      expect.objectContaining({ sourceActionId: source.id, actionId: source.id }),
    ]);
  });

  it('rejects graph fields, unknown sources, triage Actions, and generic briefs', () => {
    const source = completedAction();
    const base = {
      workItem: workItem(),
      actions: [source],
      availableVpIds: ['linus'],
    };
    const action = {
      type: 'implement',
      objective: 'Implement the dynamic execution path for this Work Item.',
      approach: 'Use focused store and Coordinator changes with regression coverage.',
      expectedOutcome: 'The dynamic execution path is runnable and verified.',
      candidateVpIds: ['linus'],
      assignmentReason: 'Linus implements code changes.',
      sourceActionIds: [source.id],
      workspaceMode: 'shared',
    };

    expect(() => prepareDynamicActionMutation({
      ...base,
      decision: { workItemType: 'software-change', actions: [{ ...action, dependsOnActionIds: [source.id] }] },
    })).toThrow(/dependency fields/i);
    expect(() => prepareDynamicActionMutation({
      ...base,
      decision: { workItemType: 'software-change', actions: [{ ...action, sourceActionIds: ['missing'] }] },
    })).toThrow(/unknown source Action/);
    expect(() => prepareDynamicActionMutation({
      ...base,
      decision: { workItemType: 'software-change', actions: [{ ...action, type: 'triage' }] },
    })).toThrow(/do not create triage Actions/);
    expect(() => prepareDynamicActionMutation({
      ...base,
      decision: { workItemType: 'software-change', actions: [{
        ...action,
        objective: 'Implement the required change with the smallest correct diff.',
      }] },
    })).toThrow(/task-specific brief/);
  });

  it('normalizes a dynamic Coordinator response without a full graph or replan decision', () => {
    const source = completedAction();
    const detail = workItem({ actions: [source], runs: [] });
    const normalized = normalizeCoordinatorResponse({
      reply: 'I will implement the next verified step.',
      decision: {
        kind: 'create_actions',
        reason: 'Research produced enough evidence to implement.',
        workItemType: 'software-change',
        contractPatch: null,
        supersedeActionIds: [],
        actions: [{
          type: 'implement',
          objective: 'Implement the Coordinator-driven dispatch path.',
          approach: 'Modify the existing store and cover the lifecycle with tests.',
          expectedOutcome: 'The dynamic dispatch path runs without a precomputed graph.',
          capability: 'implement',
          candidateVpIds: ['linus'],
          assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [source.id],
          workspaceMode: 'shared',
        }],
      },
    }, detail, { automatic: true, availableVpIds: ['linus'] });
    expect(normalized.decision.kind).toBe('create_actions');
    expect(normalized.mutation.createdActions).toHaveLength(1);

    expect(() => normalizeCoordinatorResponse({
      reply: 'I will only explain the state.',
      decision: { kind: 'answer', reason: 'No execution requested.' },
    }, detail, { automatic: true, availableVpIds: ['linus'] })).toThrow(/decision kind is invalid/);
  });

  it('persists dynamic Actions and automatically reconciles only after the runnable batch settles', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-loop-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(),
      workDir: tempDir,
      workflowTemplate: 'coordinator-driven',
      start: true,
    });
    expect(created).toMatchObject({ status: 'draft', coordinationMode: 'dynamic' });
    expect(store.claimReadyAction('premature')).toBeNull();

    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:test');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const started = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const source = [];
    const mutation = prepareDynamicActionMutation({
      workItem: started.detail,
      actions: source,
      availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'implement',
          objective: 'Implement the durable dynamic execution loop.',
          approach: 'Change the existing Coordinator and store with focused tests.',
          expectedOutcome: 'A verified dynamic Action loop is available.',
          candidateVpIds: ['linus'],
          assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    });
    const planned = store.completeCoordinatorTurn(started.turnId, {
      reply: 'Starting the next justified Action.',
      decision: {
        kind: 'create_actions', reason: 'The initial contract is actionable.',
        actions: [], guidance: [], contractPatch: null,
      },
      mutation,
    }, started.fence);
    expect(planned.actions).toHaveLength(1);
    expect(planned.actions[0]).toMatchObject({ sourceActionIds: [], dependsOnStageIds: [] });

    const claimedAction = store.claimReadyAction('runner-owner', 5_000);
    expect(claimedAction.action.id).toBe(planned.actions[0].id);
    expect(claimedAction.workItem.currentRunId).toBeNull();
    controller.submit(claimedAction.run.id, 'runner-owner', claimedAction.run.leaseEpoch, {
      outcome: 'completed', summary: 'Dynamic loop implemented',
      evidence: [{ kind: 'text', label: 'focused tests passed' }],
      acceptanceChecks: [
        { criterion: 'Actions are dynamic', status: 'passed', evidence: 'focused tests passed' },
        { criterion: 'Completion is evidence-backed', status: 'passed', evidence: 'focused tests passed' },
      ],
    });
    const settled = store.getWorkItemDetail(created.id);
    expect(settled.status).toBe('running');
    expect(store.listPendingDynamicCoordinatorWakes()).toEqual([
      expect.objectContaining({ workItemId: created.id, kind: 'action_settled' }),
    ]);
    expect(store.claimReadyAction('no-more-work')).toBeNull();

    const reconciliation = store.listPendingDynamicCoordinatorWakes()[0];
    const reconciliationClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const completionTurn = store.beginDynamicCoordinatorTurn(reconciliation.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: reconciliationClaim.claim_epoch,
    });
    const completed = store.completeCoordinatorTurn(completionTurn.turnId, {
      reply: 'The acceptance criteria are verified.',
      decision: {
        kind: 'complete', reason: 'All criteria have canonical Run evidence.',
        completion: {
          summary: 'The dynamic loop is complete.',
          acceptanceResults: [
            { criterion: 'Actions are dynamic', status: 'passed', evidenceRunIds: [claimedAction.run.id] },
            { criterion: 'Completion is evidence-backed', status: 'passed', evidenceRunIds: [claimedAction.run.id] },
          ],
          evidenceRunIds: [claimedAction.run.id], residualRisks: [],
        },
      },
    }, completionTurn.fence);
    expect(completed).toMatchObject({
      status: 'done', currentActionId: null,
      finalResult: { evidenceRunIds: [claimedAction.run.id] },
    });
  });

  it('recovers dynamic Runs and resumes cancelled WorkItems through the Coordinator', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-recovery-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:recovery');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'implement', objective: 'Implement the dynamic recovery path.',
          approach: 'Run a durable Action and simulate an expired lease.',
          expectedOutcome: 'The Action returns to ready without losing the WorkItem.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    });
    const planned = store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Starting recovery work.',
      decision: { kind: 'create_actions', reason: 'Recovery work is actionable.', actions: [] },
      mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('old-runner', 10);
    expect(acquired.action.id).toBe(planned.actions[0].id);

    now = 2_000;
    expect(store.recoverInterruptedRuns('new-runner')).toBe(1);
    expect(store.getWorkItemDetail(created.id)).toMatchObject({
      status: 'ready',
      actions: [expect.objectContaining({ id: acquired.action.id, status: 'ready' })],
    });

    controller.cancel(created.id);
    const cancelledRevision = store.getWorkItem(created.id).revision;
    const resumed = controller.resume(created.id, { revision: cancelledRevision });
    expect(resumed).toMatchObject({ status: 'running', currentActionId: null });
    expect(resumed.actions).toEqual([
      expect.objectContaining({ id: acquired.action.id, status: 'superseded' }),
    ]);
    expect(store.listPendingDynamicCoordinatorWakes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ workItemId: created.id, kind: 'work_item_resumed' }),
    ]));
  });

  it('makes new service-created WorkItems Coordinator-driven while keeping the existing UX DTO', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-service-'));
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const advance = vi.fn(() => null);
    const service = new WorkCenterService({
      yeaftDir: tempDir,
      store,
      coordinator: { advance, shutdown: vi.fn() },
      runner: null,
      settingsReader: () => ({
        startImmediately: true,
        defaultWorkDir: tempDir,
        globalInstructions: '',
        modelPolicy: { mode: 'inherit' },
        coordinatorModelPolicy: { mode: 'inherit' },
        actionInstructions: {},
        actionModelPolicies: {},
        workflows: [],
      }),
    });
    try {
      const created = await service.handle('create', {
        title: 'Coordinator-driven service item',
        goal: 'Preserve the existing Work Center UX',
        acceptanceCriteria: ['The detail DTO stays compatible'],
        workDir: tempDir,
        start: true,
      });
      expect(created).toMatchObject({
        status: 'running',
        coordinationMode: 'dynamic',
        workflowSnapshot: { planningMode: 'coordinator', executionMode: 'dynamic' },
        actions: [],
      });
      await vi.waitFor(() => expect(advance).toHaveBeenCalledTimes(1));
      expect(advance).toHaveBeenCalledWith(
        expect.any(String), expect.objectContaining({ workItemId: created.id }),
      );
      expect(store.listPendingDynamicCoordinatorWakes()).toEqual([
        expect.objectContaining({ workItemId: created.id, kind: 'work_item_started' }),
      ]);
    } finally {
      await service.shutdown();
    }
  });

  it('requires canonical owned Run evidence for every completion criterion', () => {
    const completion = normalizeDynamicCompletion({
      summary: 'The Coordinator verified the durable result.',
      acceptanceResults: [
        { criterion: 'Actions are dynamic', status: 'passed', evidenceRunIds: ['run-research'] },
        { criterion: 'Completion is evidence-backed', status: 'passed', evidenceRunIds: ['run-test'] },
      ],
      evidenceRunIds: ['run-research', 'run-test'],
      residualRisks: [],
    }, workItem().acceptanceCriteria);
    expect(completion.evidenceRunIds).toEqual(['run-research', 'run-test']);

    expect(() => normalizeDynamicCompletion({
      summary: 'Incomplete',
      acceptanceResults: [
        { criterion: 'Actions are dynamic', status: 'passed', evidenceRunIds: ['run-research'] },
        { criterion: 'Completion is evidence-backed', status: 'deferred', evidenceRunIds: ['run-test'] },
      ],
      evidenceRunIds: ['run-research', 'run-test'],
    }, workItem().acceptanceCriteria)).toThrow(/every criterion to pass/);
  });
});
