import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkItemRunner } from '../../../../agent/yeaft/work-center/runner.js';
import { resolvePlanningWorkflowSnapshot } from '../../../../agent/yeaft/work-center/workflow.js';
import {
  projectActionRequestDetail,
  projectActionRequestIndex,
  projectWorkCenterEvent,
  projectWorkItemDetail,
} from '../../../../agent/yeaft/work-center/projection.js';

function createInput(overrides = {}) {
  return {
    title: 'Fix final TODO state',
    goal: 'Ensure the final TODO state reflects the real turn outcome',
    acceptanceCriteria: ['Completed work is completed', 'Waiting work is waiting'],
    workflowTemplate: 'software-change',
    workDir: '/tmp',
    start: true,
    ...overrides,
  };
}

function completed(type, overrides = {}) {
  const plan = overrides.plan?.actions
    ? {
        ...overrides.plan,
        actions: overrides.plan.actions.map(action => ({
          ...action,
          ...(!Object.hasOwn(action, 'approach')
            ? { approach: `Use repository evidence to complete: ${action.objective}` }
            : {}),
          ...(!Object.hasOwn(action, 'expectedOutcome')
            ? { expectedOutcome: `Verified result for: ${action.objective}` }
            : {}),
        })),
      }
    : overrides.plan;
  return {
    outcome: 'completed',
    summary: `${type} complete`,
    evidence: [`${type}-evidence`],
    acceptanceChecks: createInput().acceptanceCriteria.map(criterion => ({
      criterion,
      status: 'passed',
      evidence: `${type}-evidence`,
    })),
    ...(type === 'review' ? { reviewDecision: 'approved' } : {}),
    ...overrides,
    ...(plan ? { plan } : {}),
  };
}

describe('Work Center core', () => {
  let dir;
  let now;
  let store;
  let controller;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-'));
    now = 1_000;
    store = new WorkItemStore(join(dir, 'work-center.db'), { now: () => now });
    controller = new WorkflowController(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });


  it('persists immutable generation and monotonic attempt identity on every Run claim', () => {
    const item = controller.create(createInput({ id: 'run-identity' }));
    const first = store.claimReadyAction('boot-a', 5_000);
    expect(first.run).toMatchObject({
      actionGeneration: first.action.generation,
      actionSpecHash: first.action.specHash,
      actionAttempt: 1,
    });

    store.deferRun(first.run.id, 'boot-a', first.run.leaseEpoch, 'workspace busy');
    const second = store.claimReadyAction('boot-a', 5_000);
    expect(second.action).toMatchObject({ id: first.action.id, generation: first.action.generation });
    expect(second.run).toMatchObject({
      actionGeneration: first.action.generation,
      actionSpecHash: first.action.specHash,
      actionAttempt: 2,
    });
    expect(store.getRun(first.run.id)).toMatchObject({
      actionGeneration: first.action.generation,
      actionSpecHash: first.action.specHash,
      actionAttempt: 1,
    });
    expect(store.getWorkItemDetail(item.id).events.find(event => event.type === 'run.claimed'))
      .toMatchObject({ actionGeneration: first.action.generation });
  });


  it('claims independent graph Actions concurrently and waits for dependencies', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: {
        workItemType: 'parallel-analysis',
        actions: [
          { id: 'left', type: 'research', capability: 'research', objective: 'Inspect left', dependsOnActionIds: [], workspaceMode: 'read' },
          { id: 'right', type: 'research', capability: 'research', objective: 'Inspect right', dependsOnActionIds: [], workspaceMode: 'read' },
          { id: 'review', type: 'review', capability: 'review', objective: 'Review both', dependsOnActionIds: ['left', 'right'] },
        ],
      },
    }));

    const left = store.claimReadyAction('boot-a', 5_000);
    const right = store.claimReadyAction('boot-a', 5_000);
    expect(new Set([left.action.stageId, right.action.stageId])).toEqual(new Set(['left', 'right']));
    expect(store.claimReadyAction('boot-a', 5_000)).toBeNull();
    controller.submit(left.run.id, 'boot-a', left.run.leaseEpoch, completed('research'));
    expect(store.claimReadyAction('boot-a', 5_000)).toBeNull();
    controller.submit(right.run.id, 'boot-a', right.run.leaseEpoch, completed('research'));
    expect(store.claimReadyAction('boot-a', 5_000).action.stageId).toBe('review');
    expect(store.getWorkItem(item.id).status).toBe('running');
  });

  it('keeps a graph failed while another Action submits late success and exposes retry generation in browser events', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'parallel-failure', actions: [
        { id: 'left', type: 'research', objective: 'Inspect left', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'right', type: 'research', objective: 'Inspect right', dependsOnActionIds: [], workspaceMode: 'read' },
      ] },
    }));
    const left = store.claimReadyAction('boot-a', 5_000);
    const right = store.claimReadyAction('boot-a', 5_000);
    const failed = controller.submit(left.run.id, 'boot-a', left.run.leaseEpoch, {
      outcome: 'failed', error: 'left failed', summary: '', evidence: [],
    });
    expect(failed.status).toBe('needs_attention');
    const progressed = controller.submit(
      right.run.id, 'boot-a', right.run.leaseEpoch, completed('research'),
    );
    expect(progressed.actions.find(action => action.stageId === 'right')).toMatchObject({ status: 'completed' });
    expect(store.getWorkItem(failed.id)).toMatchObject({
      status: 'needs_attention', lifecycle: 'active', attentionState: 'failed',
    });

    const failedAction = failed.actions.find(action => action.id === left.action.id);
    const retried = controller.retry(item.id, {
      expected: {
        actionId: failedAction.id,
        generation: failedAction.generation,
        revision: failed.revision,
        statuses: ['failed'],
      },
    });
    const retriedAction = retried.actions.find(action => action.id === failedAction.id);
    const event = projectWorkCenterEvent({ type: 'action.retried', workItem: retried });
    expect(retriedAction.generation).toBe(failedAction.generation + 1);
    expect(event.workItem.currentAction).toMatchObject({
      id: failedAction.id, generation: retriedAction.generation,
    });
    expect(event.workItem.actionStats.find(action => action.id === failedAction.id)).toMatchObject({
      generation: retriedAction.generation,
    });
  });

  it.each([
    ['failed', { outcome: 'failed', error: 'blocked failure', summary: '', evidence: [] }, 'needs_attention', false],
    ['waiting', { outcome: 'waiting', summary: 'Need input', evidence: [], waitingReason: 'Provide input' }, 'waiting', false],
    ['failed after blocker completes', { outcome: 'failed', error: 'blocked failure', summary: '', evidence: [] }, 'needs_attention', true],
  ])('keeps graph %s when a concurrent Run is deferred', (_label, blockedResult, expectedStatus, completeBlocker) => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'parallel-defer', actions: [
        { id: 'blocked', type: 'research', objective: 'Expose the blocker', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'blocker', type: 'research', objective: 'Keep the workspace busy', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'deferred', type: 'implement', objective: 'Wait for the workspace', dependsOnActionIds: [], workspaceMode: 'isolated-write' },
        { id: 'integrate', type: 'integrate', objective: 'Integrate the change', dependsOnActionIds: ['deferred'], workspaceMode: 'integrate' },
      ] },
    }));
    const blocked = store.claimReadyAction('boot-a', 5_000);
    const blocker = store.claimReadyAction('boot-a', 5_000);
    const deferred = store.claimReadyAction('boot-a', 5_000);
    controller.submit(blocked.run.id, 'boot-a', blocked.run.leaseEpoch, blockedResult);
    if (completeBlocker) {
      controller.submit(blocker.run.id, 'boot-a', blocker.run.leaseEpoch, completed('research'));
    }

    const detail = store.deferRun(
      deferred.run.id,
      'boot-a',
      deferred.run.leaseEpoch,
      'workspace busy',
    );

    expect(detail).toMatchObject({
      status: expectedStatus,
      currentActionId: blocked.action.id,
    });
    expect(detail.actions.find(action => action.id === deferred.action.id)).toMatchObject({
      status: 'ready', attempt: 0, currentRunId: null,
    });
    if (!completeBlocker) {
      expect(detail.actions.find(action => action.id === blocker.action.id)).toMatchObject({ status: 'running' });
    }
  });

  it('returns graph review changes to the persisted target and fences sibling late submits', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'review-return', actions: [
        { id: 'fix', type: 'implement', objective: 'Fix it', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'side', type: 'research', objective: 'Inspect it', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'review', type: 'review', objective: 'Review it', dependsOnActionIds: ['fix'], changesRequestedActionId: 'fix', workspaceMode: 'read' },
        { id: 'deliver', type: 'deliver', objective: 'Deliver it', dependsOnActionIds: ['review'] },
      ] },
    }));
    const fix = store.claimReadyAction('boot-a', 5_000);
    const side = store.claimReadyAction('boot-a', 5_000);
    controller.submit(fix.run.id, 'boot-a', fix.run.leaseEpoch, completed('implement'));
    const review = store.claimReadyAction('boot-a', 5_000);
    expect(review.action.changesRequestedStageId).toBe('fix');
    const detail = controller.submit(review.run.id, 'boot-a', review.run.leaseEpoch, completed('review', {
      reviewDecision: 'changes_requested', summary: 'Fix the blocker', evidence: ['blocker'],
    }));
    expect(detail.actions.find(action => action.stageId === 'fix')).toMatchObject({ status: 'ready' });
    expect(detail.actions.find(action => action.stageId === 'deliver')).toMatchObject({ status: 'ready' });
    expect(detail.actions.find(action => action.stageId === 'side')).toMatchObject({ status: 'running' });
    expect(detail.runs.find(run => run.id === side.run.id).status).toBe('running');
    const sideCompleted = controller.submit(
      side.run.id, 'boot-a', side.run.leaseEpoch, completed('research'),
    );
    expect(sideCompleted.actions.find(action => action.stageId === 'side')).toMatchObject({ status: 'completed' });
    expect(store.claimReadyAction('boot-a', 5_000).action.stageId).toBe('fix');
  });


  it.each([
    ['dirty repository', true],
    ['non-Git directory', false],
  ])('keeps %s isolation fallback serialized across WorkItems', async (_label, initializeGit) => {
    const workspace = mkdtempSync(join(tmpdir(), 'yeaft-workspace-fallback-'));
    try {
      if (initializeGit) {
        const git = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' });
        git(['init']);
        git(['config', 'user.name', 'Test']);
        git(['config', 'user.email', 'test@example.com']);
        writeFileSync(join(workspace, 'base.txt'), 'base\n');
        git(['add', '.']);
        git(['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'dirty.txt'), 'dirty\n');
      }
      const action = id => ({
        id: `${id}-action`, type: 'implement', stageId: 'write', workspaceMode: 'isolated-write',
      });
      store.createWorkItem(createInput({ id: 'first-fallback', workDir: workspace }), action('first'));
      store.createWorkItem(createInput({ id: 'second-fallback', workDir: workspace }), action('second'));
      const first = store.claimReadyAction('boot-a', 5_000);
      const runner = new WorkItemRunner({ store, actionWorktreeRoot: join(dir, 'worktrees') });
      const prepared = await runner.prepare({ ...first, ownerBootId: 'boot-a' });
      expect(prepared.action).toMatchObject({ workspaceMode: 'shared', workspace: null });
      expect(store.getAction(first.action.id).workspaceMode).toBe('shared');
      expect(store.claimReadyAction('boot-a', 5_000)).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });


  it.each([
    {
      name: 'dependency',
      actions: [
        { id: 'dangerous operation', type: 'operate', objective: 'Perform the dangerous operation', dependsOnActionIds: ['   '] },
        { id: 'verification', type: 'test', objective: 'Verify the dangerous operation', dependsOnActionIds: ['dangerous-operation'] },
      ],
      error: /dependencies contains an empty Action reference/,
    },
    {
      name: 'review target',
      actions: [
        { id: 'implement fix', type: 'implement', objective: 'Implement the concrete fix', dependsOnActionIds: [] },
        { id: 'review fix', type: 'review', objective: 'Review the concrete fix', dependsOnActionIds: ['implement-fix'], changesRequestedActionId: '@@@' },
      ],
      error: /review target contains an invalid Action reference/,
    },
  ])('atomically rejects an initial plan with an invalid explicit $name', ({ actions, error }) => {
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned', workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
    }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'dangerous-change', actions },
    }));

    expect(detail).toMatchObject({ status: 'needs_attention', planRevision: 0 });
    expect(detail.workflowSnapshot.stages.map(stage => stage.id)).toEqual(['triage']);
    expect(detail.actions).toHaveLength(1);
    expect(detail.actions[0]).toMatchObject({ id: triage.action.id, status: 'failed' });
    expect(detail.runs[0].error).toMatch(error);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM plan_audits WHERE work_item_id = ?').get(item.id).count)
      .toBe(0);
  });


  it.each(['constructor', '__proto__'])(
    'uses the custom execution baseline for the dynamic Action type %s',
    (type) => {
      const customInstruction = 'Use the custom baseline and verify the domain result.';
      const item = controller.create(createInput({
        workflowTemplate: 'ai-planned',
        workflowSnapshot: resolvePlanningWorkflowSnapshot({
          actionInstructions: { custom: customInstruction },
        }),
      }));
      const triage = store.claimReadyAction('boot-a', 5_000);
      const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
        plan: {
          workItemType: 'domain-task',
          actions: [{
            id: 'domain-action',
            type,
            capability: type,
            objective: 'Complete the domain-specific objective',
          }],
        },
      }));

      expect(detail.workflowSnapshot.stages.at(-1)).toMatchObject({ type });
      expect(detail.actions.at(-1).instruction).toContain(customInstruction);
      expect(detail.actions.at(-1).instruction).toContain(`Action type: ${type}`);
      expect(detail.actions.at(-1).instruction).not.toContain('function Object()');
      expect(detail.actions.at(-1).instruction).not.toContain('[object Object]');
      expect(item.workflowSnapshot.stages).toHaveLength(1);
    },
  );

  it.each([
    ['approach', { expectedOutcome: 'A verified fix in the affected code path' }],
    ['expectedOutcome', { approach: 'Inspect the affected path and implement the smallest compatible fix' }],
  ])('rejects an AI-planned Action without a task-specific %s', (field, brief) => {
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned', workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
    }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: {
        workItemType: 'bug-fix',
        actions: [{
          id: 'fix', type: 'implement', objective: 'Fix the Work Center detail failure display',
          ...brief,
          [field]: '',
        }],
      },
    }));

    expect(detail).toMatchObject({ status: 'needs_attention', currentActionId: triage.action.id });
    expect(store.getRun(triage.run.id)).toMatchObject({
      status: 'failed', error: expect.stringContaining(`task-specific ${field}`),
    });
    expect(item.workflowSnapshot.stages).toHaveLength(1);
  });


  it.each([
    ['missing', 'missing-action'],
    ['self', 'review'],
    ['future', 'deliver'],
  ])('rejects an AI-planned review with an explicit %s return target', (_kind, target) => {
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned',
      workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
    }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: {
        workItemType: 'custom-change',
        actions: [
          { id: 'fix', type: 'implement', objective: 'Implement the change' },
          { id: 'review', type: 'review', objective: 'Review independently', changesRequestedActionId: target },
          { id: 'deliver', type: 'deliver', objective: 'Deliver the result' },
        ],
      },
    }));

    expect(detail).toMatchObject({ status: 'needs_attention', currentActionId: triage.action.id });
    expect(store.getRun(triage.run.id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/invalid return Action/i),
    });
    expect(item.workflowSnapshot.stages).toHaveLength(1);
  });


  it('claims a ready Action exactly once and fences stale terminal submissions', () => {
    controller.create(createInput());
    const first = store.claimReadyAction('boot-a', 5_000);
    expect(store.claimReadyAction('boot-b', 5_000)).toBeNull();
    expect(() => controller.submit(first.run.id, 'boot-b', first.run.leaseEpoch, completed('triage')))
      .toThrow(/stale|cancelled|expired|finished/i);
  });


  it.each(['test', 'review', 'deliver'])(
    'requires every acceptance check to pass before %s can complete',
    (type) => {
      const targetStage = {
        id: type,
        name: type,
        type,
        instruction: 'Verify the WorkItem contract',
        assignmentPolicy: { mode: 'fixed', fixedVpId: 'omni' },
        modelPolicy: { mode: 'inherit' },
        maxAttempts: 2,
      };
      const stages = type === 'review'
        ? [{ ...targetStage, id: 'implement', type: 'implement' }, {
            ...targetStage, changesRequestedStageId: 'implement',
          }]
        : [targetStage];
      const workflowSnapshot = {
        version: 1,
        id: `verify-${type}`,
        name: `Verify ${type}`,
        stages,
      };
      controller.create(createInput({ workflowTemplate: workflowSnapshot.id, workflowSnapshot }));
      if (type === 'review') {
        const implement = store.claimReadyAction('boot-a', 5_000);
        controller.submit(
          implement.run.id, 'boot-a', implement.run.leaseEpoch, completed('implement'),
        );
      }
      const claim = store.claimReadyAction('boot-a', 5_000);
      const result = completed(type, {
        acceptanceChecks: createInput().acceptanceCriteria.map(criterion => ({
          criterion, status: 'not_applicable', evidence: 'executor declared this irrelevant',
        })),
      });
      const detail = controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, result);

      expect(detail.status).toBe('needs_attention');
      expect(store.getRun(claim.run.id).error).toMatch(/requires every acceptance check to pass/i);
    },
  );


  it.each([
    ['completed', completed('triage')],
    ['waiting', { outcome: 'waiting', summary: 'Need input', evidence: [], waitingReason: 'Provide input' }],
    ['failed', { outcome: 'failed', summary: 'Failed', evidence: [], error: 'broken' }],
  ])('increments the v2 ledger for a %s terminal Run and fences the canonical result', (_outcome, result) => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    const generation = claim.action.generation;

    controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, result);

    const detail = store.getWorkItemDetail(item.id);
    expect(detail.ledgerRevision).toBe(1);
    expect(store.getAction(claim.action.id)).toMatchObject({
      generation,
      resultRunId: result.outcome === 'completed' ? claim.run.id : null,
    });
    expect(store.finalizeRun(claim.run.id, 'boot-a', claim.run.leaseEpoch, result, () => {
      throw new Error('stale terminal callback must not run');
    })).toBeNull();
    expect(store.getWorkItem(item.id).ledgerRevision).toBe(1);
  });


  it('cancels the Run atomically and rejects its late submit and recovery', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    const cancelled = controller.cancel(item.id);
    expect(cancelled.status).toBe('cancelled');
    expect(store.getRun(claim.run.id).status).toBe('cancelled');
    expect(() => controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed('triage')))
      .toThrow(/stale|cancelled|expired|finished/i);
    expect(store.recoverInterruptedRuns('new-boot')).toBe(0);
    expect(store.getWorkItem(item.id).status).toBe('cancelled');
  });

  it('retriages atomically and an old Run cannot restore the old revision', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    const updated = controller.update(item.id, { goal: 'Revision two' });
    expect(updated.revision).toBe(2);
    expect(updated.actions[0].status).toBe('superseded');
    expect(updated.runs[0].status).toBe('superseded');
    expect(() => controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed('triage')))
      .toThrow(/stale|cancelled|expired|finished/i);
    expect(store.recoverInterruptedRuns('new-boot')).toBe(0);
    expect(store.getWorkItem(item.id).goal).toBe('Revision two');
  });

  it('rolls back every finalization write when the transaction faults', () => {
    const faultDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-fault-'));
    const faultStore = new WorkItemStore(join(faultDir, 'work-center.db'), {
      now: () => now,
      onTransitionStep(step) {
        if (step === 'after_run_update') throw new Error('simulated crash');
      },
    });
    const faultController = new WorkflowController(faultStore);
    faultController.create(createInput());
    const claim = faultStore.claimReadyAction('boot-a', 5_000);
    expect(() => faultController.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed('triage')))
      .toThrow(/simulated crash/);
    expect(faultStore.getRun(claim.run.id).status).toBe('running');
    expect(faultStore.getAction(claim.action.id).status).toBe('running');
    expect(faultStore.getWorkItem(claim.workItem.id).status).toBe('running');
    faultStore.close();
    rmSync(faultDir, { recursive: true, force: true });
  });

  it('interrupts only the fenced current Run and makes it claimable again', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    expect(store.interruptRun(claim.run.id, 'boot-b', claim.run.leaseEpoch, 'wrong owner')).toBe(false);
    expect(store.getWorkItem(item.id).status).toBe('running');
    store.updateRunProgress(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      response: 'Changed src/current.js and started focused tests',
      loopCount: 2,
      toolCount: 2,
      checkpoint: {
        version: 1,
        toolEvents: [
          { name: 'FileEdit', status: 'completed', resource: 'src/current.js' },
          { name: 'Bash', status: 'completed', resource: '/tmp' },
        ],
      },
    });
    expect(store.interruptRun(claim.run.id, 'boot-a', claim.run.leaseEpoch, 'watcher stopped')).toBe(true);
    expect(store.getRun(claim.run.id).status).toBe('interrupted');
    expect(store.getWorkItem(item.id).status).toBe('ready');
    const next = store.claimReadyAction('boot-a', 5_000);
    expect(next?.action.id).toBe(claim.action.id);
    expect(store.getActionResumeContext(claim.action.id, next.run.id)).toMatchObject({
      status: 'interrupted',
      response: 'Changed src/current.js and started focused tests',
      checkpoint: {
        toolEvents: [
          { name: 'FileEdit', status: 'completed', resource: 'src/current.js' },
          { name: 'Bash', status: 'completed', resource: '/tmp' },
        ],
      },
    });
  });

  it('atomically rolls back final progress when interruption transition faults', () => {
    const faultDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-interrupt-fault-'));
    const faultStore = new WorkItemStore(join(faultDir, 'work-center.db'), {
      now: () => now,
      onTransitionStep(step) {
        if (step === 'after_interrupt_run_update') throw new Error('simulated interruption crash');
      },
    });
    const faultController = new WorkflowController(faultStore);
    faultController.create(createInput());
    const claim = faultStore.claimReadyAction('boot-a', 5_000);
    faultStore.updateRunProgress(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      response: 'older durable progress', loopCount: 1, toolCount: 1, checkpoint: null,
    });

    expect(() => faultStore.interruptRun(
      claim.run.id,
      'boot-a',
      claim.run.leaseEpoch,
      'watcher stopped',
      {
        response: 'new final progress',
        loopCount: 2,
        toolCount: 2,
        checkpoint: {
          version: 1,
          toolEvents: [{ name: 'FileEdit', status: 'completed', resource: 'important.js' }],
        },
      },
    )).toThrow(/simulated interruption crash/);
    expect(faultStore.getRun(claim.run.id)).toMatchObject({
      status: 'running',
      response: 'older durable progress',
      loopCount: 1,
      toolCount: 1,
      checkpoint: null,
    });
    expect(faultStore.getAction(claim.action.id).status).toBe('running');
    expect(faultStore.getWorkItem(claim.workItem.id).status).toBe('running');
    faultStore.close();
    rmSync(faultDir, { recursive: true, force: true });
  });


  it('recovers only the currently fenced expired Run', () => {
    const firstItem = controller.create(createInput());
    const firstRun = store.claimReadyAction('old-boot', 10);
    now += 20;
    expect(store.recoverInterruptedRuns('new-boot')).toBe(1);
    expect(store.getWorkItem(firstItem.id).status).toBe('ready');
    expect(store.getRun(firstRun.run.id).status).toBe('interrupted');
  });
});
