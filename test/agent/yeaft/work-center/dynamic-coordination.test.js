import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
import { WorkItemCoordinator, normalizeCoordinatorResponse } from '../../../../agent/yeaft/work-center/coordinator.js';
import { Registry } from '../../../../agent/yeaft/vp/registry.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
import { projectWorkItemDetail } from '../../../../agent/yeaft/work-center/projection.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { buildMainlineContextSnapshot } from '../../../../agent/yeaft/work-center/mainline-projection.js';
import { WorkItemRunner, parseStructuredResult } from '../../../../agent/yeaft/work-center/runner.js';

function workItem(overrides = {}) {
  return {
    id: 'work-item-1',
    coordinationMode: DYNAMIC_COORDINATION_MODE,
    executionSchemaVersion: DYNAMIC_EXECUTION_SCHEMA_VERSION,
    title: 'Ship a durable dynamic loop',
    goal: 'Let the Coordinator create only currently justified Actions',
    acceptanceCriteria: ['Actions are dynamic', 'Completion is evidence-backed'],
    deliveryTarget: 'workspace_files',
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
    const detail = workItem({
      goal: 'Implement the dynamic loop and stop after the verified repository files are ready.',
      actions: [source], runs: [],
    });
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
      outputs: [{ kind: 'file', label: 'Implementation', ref: 'src/dynamic-loop.js' }],
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
    expect(() => store.db.prepare('UPDATE work_items SET final_result = ? WHERE id = ?')
      .run(JSON.stringify({ summary: 'rewritten' }), created.id))
      .toThrow(/WorkItem final result is immutable/);
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

  it('runs a real dynamic Action and persists an action-journal execution manifest', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-runner-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:runner');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['omni'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'test', objective: 'Execute a real dynamic WorkItem Runner.',
          approach: 'Run the Engine with a terminal structured response.',
          expectedOutcome: 'The dynamic Mainline manifest is persisted.',
          candidateVpIds: ['omni'], assignmentReason: 'Omni is the test executor.',
          sourceActionIds: [], workspaceMode: 'read',
        }],
      },
    });
    store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Starting the real Runner Action.',
      decision: { kind: 'create_actions', reason: 'The Action is runnable.', actions: [] },
      mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('runner-owner', 5_000);
    const adapter = {
      async *stream(params) {
        params.onRequestStart?.();
        yield { type: 'text_delta', text: JSON.stringify({
          outcome: 'completed', summary: 'Runner completed.',
          evidence: ['real dynamic runner evidence'],
          acceptanceChecks: [
            { criterion: 'Actions are dynamic', status: 'passed', evidence: 'runner manifest' },
            { criterion: 'Completion is evidence-backed', status: 'deferred', evidence: 'Coordinator verifies' },
          ],
        }) };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };
    const runner = new WorkItemRunner({
      store,
      runtimeProvider: async () => ({
        defaultWorkDir: tempDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024, projectDocMaxBytes: 0 },
        adapter,
      }),
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'tester', traits: ['test'] }],
        getVp: id => id === 'omni'
          ? { id: 'omni', name: 'Omni', role: 'tester', traits: ['test'] } : null,
      },
    });
    const result = await runner.run({
      ...acquired, ownerBootId: 'runner-owner', signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ outcome: 'completed', summary: 'Runner completed.' });
    expect(store.getRun(acquired.run.id)?.executionManifest).toMatchObject({
      schemaVersion: 2, planRevision: 1,
    });
  });

  it.each([
    ['unexpired', 1_001],
    ['expired', 2_000],
  ])('requeues an automatic Coordinator wake after a %s pre-dispatch crash', (_lease, reopenAt) => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-coordinator-crash-'));
    let now = 1_000;
    const dbPath = join(tempDir, 'work-center.db');
    store = new WorkItemStore(dbPath, { now: () => now });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, `dynamic:create:${_lease}`);
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-before-crash', 100);
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-before-crash', claimEpoch: claim.claim_epoch,
    });
    expect(turn).not.toBeNull();
    store.close();
    store = null;
    now = reopenAt;
    store = new WorkItemStore(dbPath, { now: () => now });
    expect(store.getWorkItemDetail(created.id).messages.at(-1)).toMatchObject({
      role: 'assistant', status: 'failed',
    });
    expect(store.listPendingDynamicCoordinatorWakes()).toEqual([
      expect.objectContaining({ id: mailbox.id, workItemId: created.id }),
    ]);
  });

  it('rejects WorkItem completion backed by a canonical Run with no evidence or acceptance checks', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-empty-evidence-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:empty-evidence');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'test', objective: 'Create an invalid canonical completion fixture.',
          approach: 'Persist a completed Run without evidence or acceptance checks.',
          expectedOutcome: 'The final completion gate rejects the Run.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns the fixture.',
          sourceActionIds: [], workspaceMode: 'read',
        }],
      },
    });
    store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Starting invalid evidence fixture.',
      decision: { kind: 'create_actions', reason: 'Fixture is runnable.', actions: [] }, mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('runner-owner', 5_000);
    store.closeRunInput(acquired.run.id, 'runner-owner', acquired.run.leaseEpoch);
    store.finalizeRun(acquired.run.id, 'runner-owner', acquired.run.leaseEpoch, {
      outcome: 'completed', summary: 'No proof', evidence: [], acceptanceChecks: [],
    }, () => { throw new Error('legacy transition must not run'); });
    const reconciliation = store.listPendingDynamicCoordinatorWakes()[0];
    const completionClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const completionTurn = store.beginDynamicCoordinatorTurn(reconciliation.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: completionClaim.claim_epoch,
    });
    expect(() => store.completeCoordinatorTurn(completionTurn.turnId, {
      reply: 'Claiming completion without proof.',
      decision: {
        kind: 'complete', reason: 'The invalid Run claims success.',
        completion: {
          summary: 'Invalid completion',
          acceptanceResults: [
            { criterion: 'Actions are dynamic', status: 'passed', evidenceRunIds: [acquired.run.id] },
            { criterion: 'Completion is evidence-backed', status: 'passed', evidenceRunIds: [acquired.run.id] },
          ],
          evidenceRunIds: [acquired.run.id], residualRisks: [],
        },
      },
    }, completionTurn.fence)).toThrow(/evidence|acceptance/i);
  });

  it('enqueues reconciliation when interrupted recovery exhausts a dynamic Action', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-terminal-recovery-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:terminal-recovery');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change',
        actions: [{
          type: 'implement', objective: 'Exercise terminal interrupted recovery.',
          approach: 'Expire the only allowed Run attempt.',
          expectedOutcome: 'The Coordinator receives a reconciliation wake.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns recovery.',
          sourceActionIds: [], workspaceMode: 'shared', maxAttempts: 1,
        }],
      },
    });
    store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Starting terminal recovery fixture.',
      decision: { kind: 'create_actions', reason: 'Fixture is runnable.', actions: [] }, mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('old-runner', 10);
    now = 2_000;
    expect(store.recoverInterruptedRuns('new-runner')).toBe(1);
    expect(store.getAction(acquired.action.id)).toMatchObject({ status: 'failed' });
    expect(store.listPendingDynamicCoordinatorWakes()).toEqual([
      expect.objectContaining({ workItemId: created.id, kind: 'action_settled' }),
    ]);
  });

  it('closes obsolete failed Actions without treating them as acceptance evidence', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-close-failed-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const initialMailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:close');
    const initialClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const initialTurn = store.beginDynamicCoordinatorTurn(initialMailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: initialClaim.claim_epoch,
    });
    const initialMutation = prepareDynamicActionMutation({
      workItem: initialTurn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change', actions: [{
          type: 'research', objective: 'Attempt an obsolete specialist review.',
          approach: 'Run the review once and retain its failure for audit.',
          expectedOutcome: 'The failed Action can be explicitly closed.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus exercises the failed path.',
          sourceActionIds: [], workspaceMode: 'read', maxAttempts: 1,
        }],
      },
    });
    store.completeCoordinatorTurn(initialTurn.turnId, {
      reply: 'Starting the obsolete review.',
      decision: { kind: 'create_actions', reason: 'The failure fixture is runnable.', actions: [] },
      mutation: initialMutation,
    }, initialTurn.fence);
    const failedClaim = store.claimReadyAction('runner-owner', 5_000);
    controller.submit(failedClaim.run.id, 'runner-owner', failedClaim.run.leaseEpoch, {
      outcome: 'failed', summary: '', evidence: [], error: 'No matching specialist is available',
    });
    const failedDetail = store.getWorkItemDetail(created.id);
    const reconciliation = store.listPendingDynamicCoordinatorWakes()[0];
    const closeClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const closeTurn = store.beginDynamicCoordinatorTurn(reconciliation.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: closeClaim.claim_epoch,
    });
    const replacementMutation = prepareDynamicActionMutation({
      workItem: closeTurn.detail, actions: closeTurn.detail.actions, availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change', actions: [{
          type: 'write', objective: 'Produce the canonical verified result.',
          approach: 'Use the available evidence and emit a structured output.',
          expectedOutcome: 'A concrete file output backed by canonical Run evidence.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus can produce the canonical result.',
          sourceActionIds: [failedClaim.action.id], workspaceMode: 'shared',
        }],
      },
    });
    const replanned = store.completeCoordinatorTurn(closeTurn.turnId, {
      reply: 'Closing the obsolete Action and running the viable replacement.',
      decision: { kind: 'create_actions', reason: 'The failed Action is no longer required.', actions: [] },
      mutation: replacementMutation,
    }, closeTurn.fence);
    expect(replanned.actions.find(action => action.id === failedClaim.action.id)).toMatchObject({
      status: 'failed',
    });
    const replacementClaim = store.claimReadyAction('runner-owner', 5_000);
    controller.submit(replacementClaim.run.id, 'runner-owner', replacementClaim.run.leaseEpoch, {
      outcome: 'completed', summary: 'Canonical result produced',
      evidence: [{ kind: 'file', label: 'Design', ref: 'docs/design.md' }],
      outputs: [{ kind: 'file', label: 'Design', ref: 'docs/design.md' }],
      acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
        criterion, status: 'passed', evidence: 'docs/design.md',
      })),
    });
    const finalWake = store.listPendingDynamicCoordinatorWakes().find(entry => entry.workItemId === created.id);
    const finalClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const finalTurn = store.beginDynamicCoordinatorTurn(finalWake.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: finalClaim.claim_epoch,
    });
    const completed = store.completeCoordinatorTurn(finalTurn.turnId, {
      reply: 'The viable work is complete.',
      decision: {
        kind: 'complete', reason: 'All criteria have canonical evidence and obsolete work is closed.',
        closeActions: [{
          actionId: failedClaim.action.id,
          reason: 'The broader evidence Action supersedes this unavailable specialist review.',
        }],
        completion: {
          summary: 'Complete',
          acceptanceResults: workItem().acceptanceCriteria.map(criterion => ({
            criterion, status: 'passed', evidenceRunIds: [replacementClaim.run.id],
          })),
          evidenceRunIds: [replacementClaim.run.id], residualRisks: [],
        },
      },
    }, finalTurn.fence);
    expect(failedDetail.actions.find(action => action.id === failedClaim.action.id).status).toBe('failed');
    expect(completed.actions.find(action => action.id === failedClaim.action.id)).toMatchObject({
      status: 'closed',
      closeReason: 'The broader evidence Action supersedes this unavailable specialist review.',
    });
    expect(completed.status).toBe('done');
    expect(completed.finalResult.evidenceRunIds).toEqual([replacementClaim.run.id]);
  });

  it('keeps canonical Run identity, checks, and outputs in completed Coordinator snapshots', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-coordinator-snapshot-'));
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const initial = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:snapshot');
    const initialClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const initialTurn = store.beginDynamicCoordinatorTurn(initial.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: initialClaim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: initialTurn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'documentation', actions: [{
          type: 'write', objective: 'Produce one canonical document.',
          approach: 'Write the requested file and return structured evidence.',
          expectedOutcome: 'The Coordinator can complete directly from the Run snapshot.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus writes the document.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    });
    store.completeCoordinatorTurn(initialTurn.turnId, {
      reply: 'Writing the document.',
      decision: { kind: 'create_actions', reason: 'The task is actionable.', actions: [] }, mutation,
    }, initialTurn.fence);
    const run = store.claimReadyAction('runner-owner', 5_000);
    controller.submit(run.run.id, 'runner-owner', run.run.leaseEpoch, {
      outcome: 'completed', summary: 'Document ready',
      evidence: [{ kind: 'file', label: 'Design', ref: 'docs/design.md' }],
      outputs: [{ kind: 'file', label: 'Design', ref: 'docs/design.md' }],
      acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
        criterion, status: 'passed', evidence: 'docs/design.md',
      })),
    });
    let snapshot = null;
    const coordinator = new WorkItemCoordinator({
      store,
      registry: { listVps: () => [{ id: 'linus', name: 'Linus', role: 'systems' }] },
      policyProvider: async () => ({ coordinatorModelPolicy: { mode: 'inherit' } }),
      runtimeProvider: async () => ({
        config: { model: 'provider/model', maxOutputTokens: 1_024 },
        adapter: { call: async request => {
          request.onRequestStart?.();
          snapshot = JSON.parse(request.messages[0].content.match(/Current WorkItem snapshot:\n([\s\S]*?)\n\nLatest user message:/)?.[1]);
          return { text: JSON.stringify({
            reply: 'The existing canonical Run is sufficient.',
            decision: {
              kind: 'complete', reason: 'No evidence-packaging Action is required.', closeActions: [],
              completion: {
                summary: 'Complete',
                acceptanceResults: workItem().acceptanceCriteria.map(criterion => ({
                  criterion, status: 'passed', evidenceRunIds: [run.run.id],
                })),
                evidenceRunIds: [run.run.id], residualRisks: [],
              },
            },
          }) };
        } },
      }),
    });
    const existingWake = store.listPendingDynamicCoordinatorWakes()[0];
    const coordinatorClaim = store.claimCoordinatorMailbox(created.id, coordinator.ownerBootId);
    const started = store.beginDynamicCoordinatorTurn(existingWake.id, {
      ownerBootId: coordinator.ownerBootId, claimEpoch: coordinatorClaim.claim_epoch,
    });
    const turn = coordinator.resume(started, {
      text: 'Finish from the existing evidence.',
    });
    const completed = await turn.task;
    expect(snapshot.actions[0].result).toMatchObject({
      runId: run.run.id,
      outputs: [{ kind: 'file', label: 'Design', ref: 'docs/design.md' }],
      acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
        criterion, status: 'passed', evidence: 'docs/design.md',
      })),
    });
    expect(completed.status).toBe('done');
    expect(completed.actions).toHaveLength(1);
  });

  it('provisions a specialized VP through an assigned VP authoring Action', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-vp-provision-'));
    const registry = new Registry();
    registry.setVp({
      id: 'linus', name: 'Linus', role: 'Systems Engineer', traits: ['systems', 'engineering'],
      persona: 'Build the smallest correct system.',
    });
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:vp-provision');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'software-change', actions: [{
          type: 'create_vp', objective: 'Create a specialist for accessibility review.',
          approach: 'Have Linus author a focused persistent VP definition using the dedicated tool.',
          expectedOutcome: 'The specialist VP is available for later Work Center Actions.',
          capability: 'vp_authoring', candidateVpIds: ['linus'],
          assignmentReason: 'Linus is the best available systems-oriented VP to author the specialist.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    });
    store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Creating the missing specialist.',
      decision: { kind: 'create_actions', reason: 'No existing VP covers the required specialty.', actions: [] },
      mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('runner-owner', 5_000);
    let adapterCalls = 0;
    const adapter = {
      async *stream(params) {
        params.onRequestStart?.();
        adapterCalls += 1;
        if (adapterCalls === 1) {
          const tool = params.tools.find(candidate => candidate.name === 'CreateWorkItemVp');
          expect(tool).toBeTruthy();
          yield { type: 'tool_call', id: 'create-vp', name: 'CreateWorkItemVp', input: {
            vpId: 'accessibility-reviewer', displayName: 'Accessibility Reviewer',
            role: 'Accessibility reviewer', area: 'quality', traits: ['accessibility', 'review'],
            persona: 'Review user-facing behavior for accessibility with concrete evidence.',
          } };
          yield { type: 'stop', stopReason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: JSON.stringify({
          outcome: 'completed', summary: 'Specialist VP created.',
          evidence: [{ kind: 'text', label: 'VP accessibility-reviewer created' }],
          acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
            criterion, status: 'deferred', evidence: 'Specialist creation is an intermediate step',
          })),
        }) };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };
    const runner = new WorkItemRunner({
      store, yeaftDir: tempDir,
      runtimeProvider: async () => ({
        defaultWorkDir: tempDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024, projectDocMaxBytes: 0 },
        adapter,
      }),
      registry,
    });
    const result = await runner.run({
      ...acquired, ownerBootId: 'runner-owner', signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ outcome: 'completed', summary: 'Specialist VP created.' });
    expect(store.getRun(acquired.run.id).toolPolicySnapshot.allowedToolNames)
      .toContain('CreateWorkItemVp');
    expect(registry.getVp('accessibility-reviewer')).toMatchObject({
      id: 'accessibility-reviewer', role: 'Accessibility reviewer',
    });
    expect(existsSync(join(tempDir, 'virtual-persons', 'accessibility-reviewer', 'role.md'))).toBe(true);
  });

  it('normalizes structured outputs and exposes them on the final WorkItem result', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-outputs-'));
    let now = 1_000;
    store = new WorkItemStore(join(tempDir, 'work-center.db'), { now: () => now++ });
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const mailbox = store.enqueueCoordinatorMailbox(created.id, 'work_item_created', {}, 'dynamic:create:outputs');
    const claim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const turn = store.beginDynamicCoordinatorTurn(mailbox.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: claim.claim_epoch,
    });
    const mutation = prepareDynamicActionMutation({
      workItem: turn.detail, actions: [], availableVpIds: ['linus'],
      decision: {
        workItemType: 'documentation', actions: [{
          type: 'write', objective: 'Write the requested design document.',
          approach: 'Create and verify the document in the Work Item workspace.',
          expectedOutcome: 'A structured file output is available to the user.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns the document.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    });
    store.completeCoordinatorTurn(turn.turnId, {
      reply: 'Writing the document.',
      decision: { kind: 'create_actions', reason: 'The file delivery boundary is explicit.', actions: [] }, mutation,
    }, turn.fence);
    const acquired = store.claimReadyAction('runner-owner', 5_000);
    controller.submit(acquired.run.id, 'runner-owner', acquired.run.leaseEpoch, {
      outcome: 'completed', summary: 'Document written',
      evidence: [{ kind: 'file', label: 'Design document', ref: 'docs/design.md' }],
      outputs: [
        { kind: 'file', label: 'Design document', ref: 'docs/design.md' },
        { kind: 'link', label: 'Pull request', ref: 'https://github.com/example/repo/pull/1' },
      ],
      acceptanceChecks: workItem().acceptanceCriteria.map(criterion => ({
        criterion, status: 'passed', evidence: 'docs/design.md',
      })),
    });
    const wake = store.listPendingDynamicCoordinatorWakes()[0];
    const completeClaim = store.claimCoordinatorMailbox(created.id, 'coordinator-owner');
    const completeTurn = store.beginDynamicCoordinatorTurn(wake.id, {
      ownerBootId: 'coordinator-owner', claimEpoch: completeClaim.claim_epoch,
    });
    const completed = store.completeCoordinatorTurn(completeTurn.turnId, {
      reply: 'The requested outputs are ready.',
      decision: {
        kind: 'complete', reason: 'The explicit file delivery boundary is satisfied.',
        completion: {
          summary: 'Outputs ready',
          acceptanceResults: workItem().acceptanceCriteria.map(criterion => ({
            criterion, status: 'passed', evidenceRunIds: [acquired.run.id],
          })),
          evidenceRunIds: [acquired.run.id], residualRisks: [],
        },
      },
    }, completeTurn.fence);
    expect(store.getRun(acquired.run.id).outputs).toEqual([
      { kind: 'file', label: 'Design document', ref: 'docs/design.md' },
      { kind: 'link', label: 'Pull request', ref: 'https://github.com/example/repo/pull/1' },
    ]);
    expect(completed.finalResult.outputs).toEqual([
      { kind: 'file', label: 'Design document', ref: 'docs/design.md', runId: acquired.run.id },
      { kind: 'link', label: 'Pull request', ref: 'https://github.com/example/repo/pull/1', runId: acquired.run.id },
    ]);
    expect(() => store.db.prepare('UPDATE runs SET outputs = ? WHERE id = ?')
      .run('[{"kind":"file","label":"rewritten","ref":"late.md"}]', acquired.run.id))
      .toThrow(/terminal Run result is immutable/);
    const projected = projectWorkItemDetail(completed);
    expect(projected.outputs).toEqual([
      { kind: 'file', label: 'Design document', ref: 'docs/design.md', actionId: acquired.action.id, runId: acquired.run.id },
      { kind: 'link', label: 'Pull request', ref: 'https://github.com/example/repo/pull/1', actionId: acquired.action.id, runId: acquired.run.id },
    ]);
  });

  it('persists an explicit delivery target and lets it authorize mutating Actions', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-dynamic-delivery-target-'));
    store = new WorkItemStore(join(tempDir, 'work-center.db'));
    const controller = new WorkflowController(store);
    const created = controller.create({
      ...workItem(), goal: 'Implement the requested change.', deliveryTarget: 'pull_request',
      workDir: tempDir, workflowTemplate: 'coordinator-driven', start: true,
    });
    const detail = store.getWorkItemDetail(created.id);
    expect(detail.deliveryTarget).toBe('pull_request');
    expect(() => normalizeCoordinatorResponse({
      reply: 'The pull-request boundary is explicit.',
      decision: {
        kind: 'create_actions', reason: 'Implementation may proceed.',
        workItemType: 'software-change', actions: [{
          type: 'implement', objective: 'Implement the requested change.',
          approach: 'Modify the repository and verify focused tests.',
          expectedOutcome: 'A verified change ready for the requested pull request.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    }, detail, { automatic: true, availableVpIds: ['linus'] })).not.toThrow();
  });

  it('rejects unsafe output references before persistence', () => {
    const parsed = parseStructuredResult(JSON.stringify({
      outcome: 'completed', summary: 'Mixed outputs', evidence: ['verified'],
      outputs: [
        { kind: 'file', label: 'Traversal', ref: '../secret.txt' },
        { kind: 'file', label: 'Absolute', ref: '/tmp/secret.txt' },
        { kind: 'link', label: 'Credential URL', ref: 'https://user:pass@example.test/private' },
        { kind: 'file', label: 'Safe file', ref: './docs/design.md' },
      ],
      acceptanceChecks: [],
    }), 'write');
    expect(parsed.outputs).toEqual([{ kind: 'file', label: 'Safe file', ref: 'docs/design.md' }]);
  });

  it('requires a human decision when the delivery boundary is ambiguous', () => {
    const detail = workItem({ deliveryTarget: null, actions: [], runs: [] });
    expect(() => normalizeCoordinatorResponse({
      reply: 'I will start coding.',
      decision: {
        kind: 'create_actions', reason: 'The technical implementation is clear.',
        workItemType: 'software-change', actions: [{
          type: 'implement', objective: 'Implement the requested change.',
          approach: 'Modify the repository and verify focused tests.',
          expectedOutcome: 'A code change exists, but delivery is unspecified.',
          candidateVpIds: ['linus'], assignmentReason: 'Linus owns implementation.',
          sourceActionIds: [], workspaceMode: 'shared',
        }],
      },
    }, detail, { automatic: true, availableVpIds: ['linus'] }))
      .toThrow(/delivery boundary.*request_human/i);
    const question = normalizeCoordinatorResponse({
      reply: 'The implementation scope is clear, but the delivery boundary is not.',
      decision: {
        kind: 'request_human', reason: 'File-only, PR, and merged delivery require different authority.',
        question: 'Should this Work Item stop after generating files, open a PR, or merge the approved PR?',
      },
    }, detail, { automatic: true, availableVpIds: ['linus'] });
    expect(question.decision.kind).toBe('request_human');
    expect(normalizeCoordinatorResponse({
      reply: 'I inferred a pull request.',
      decision: {
        kind: 'request_human', reason: 'Confirmation is required.',
        question: 'Should I open a pull request?',
        contractPatch: { deliveryTarget: 'pull_request' },
      },
    }, detail, { automatic: true, availableVpIds: ['linus'] }).decision.contractPatch).toBeNull();
    expect(normalizeCoordinatorResponse({
      reply: 'You selected a pull request.',
      decision: {
        kind: 'request_human', reason: 'Persist the user-confirmed boundary.',
        question: 'Proceed with the confirmed pull request boundary?',
        contractPatch: { deliveryTarget: 'pull_request' },
      },
    }, detail, { automatic: false, availableVpIds: ['linus'] }).decision.contractPatch)
      .toEqual({ deliveryTarget: 'pull_request' });
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
