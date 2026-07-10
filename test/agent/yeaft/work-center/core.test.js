import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';

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
  return {
    outcome: 'completed',
    summary: `${type} complete`,
    evidence: [`${type}-evidence`],
    ...(type === 'review' ? { reviewDecision: 'approved' } : {}),
    ...overrides,
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

  it('creates an Agent-level WorkItem with a ready triage Action', () => {
    const item = controller.create(createInput({
      origin: { sessionId: 'session-1', messageId: 'message-1', createdBy: 'user' },
      linkedSessionIds: ['session-1'],
    }));
    const detail = store.getWorkItemDetail(item.id);
    expect(detail.status).toBe('ready');
    expect(detail.actions[0]).toMatchObject({
      type: 'triage', requiredRole: 'omni', status: 'ready', contractRevision: 1,
    });
    expect(detail.origin).toEqual({ sessionId: 'session-1', messageId: 'message-1', createdBy: 'user' });
    expect(detail.linkedSessionIds).toEqual(['session-1']);
    expect(store.listWorkItems({ sessionId: 'session-1' }).map(row => row.id)).toEqual([item.id]);
  });

  it('reuses only structured completed context from the same explicit work directory', () => {
    const source = controller.create(createInput({ title: 'Earlier work' }));
    for (const type of ['triage', 'implement', 'review', 'deliver']) {
      const claim = store.claimReadyAction('boot-a', 5_000);
      controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed(type, type === 'triage' ? {
        summary: 'Earlier project decision',
        evidence: [{ kind: 'file', label: 'Config', ref: 'config.json', stdout: 'hidden' }],
      } : {}));
    }

    const reused = controller.create(createInput({ title: 'Follow-up work' }));
    const reusedAction = store.getWorkItemDetail(reused.id).actions[0];
    expect(reusedAction.context).toContainEqual({
      type: 'triage',
      role: 'omni',
      summary: 'Earlier project decision',
      evidence: [{ kind: 'file', label: 'Config', ref: 'config.json' }],
      reviewDecision: null,
      sourceTitle: 'Earlier work',
    });
    expect(reusedAction.instruction).toContain('Earlier project decision');
    expect(reusedAction.instruction).not.toContain('hidden');

    const isolated = controller.create(createInput({
      title: 'Isolated work',
      workDir: dir,
      reuseMemory: false,
    }));
    expect(store.getWorkItemDetail(isolated.id).actions[0].context).toEqual([]);
    expect(source.id).not.toBe(reused.id);
  });

  it('uses a creation-time canonical workspace identity for memory reuse', () => {
    const projectA = mkdtempSync(join(dir, 'project-a-'));
    const projectB = mkdtempSync(join(dir, 'project-b-'));
    const alias = join(dir, 'current');
    symlinkSync(projectA, alias);
    const source = controller.create(createInput({ title: 'Project A', workDir: alias }));
    for (const type of ['triage', 'implement', 'review', 'deliver']) {
      const claim = store.claimReadyAction('boot-a', 5_000);
      controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed(type, type === 'triage'
        ? { summary: 'Project A only' }
        : {}));
    }

    const equivalent = controller.create(createInput({ title: 'Equivalent path', workDir: `${projectA}/` }));
    expect(store.getWorkItemDetail(equivalent.id).actions[0].instruction).toContain('Project A only');

    unlinkSync(alias);
    symlinkSync(projectB, alias);
    const retargeted = controller.create(createInput({ title: 'Project B', workDir: alias }));
    expect(store.getWorkItemDetail(retargeted.id).actions[0].instruction).not.toContain('Project A only');
    expect(store.getWorkItem(source.id).workspaceKey).toBe(projectA);
  });

  it('restarts only the current Action when the user adds guidance', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    const guided = controller.guide(item.id, {
      guidance: 'Keep the public API unchanged',
      actionId: claim.action.id,
      revision: item.revision,
    });

    expect(store.getRun(claim.run.id).status).toBe('superseded');
    expect(guided.status).toBe('ready');
    expect(guided.actions).toHaveLength(2);
    expect(guided.actions[0].status).toBe('superseded');
    expect(guided.actions[1]).toMatchObject({ type: 'triage', requiredRole: 'omni', status: 'ready' });
    expect(guided.actions[1].instruction).toContain('Keep the public API unchanged');
    expect(() => controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed('triage')))
      .toThrow(/stale|cancelled|expired|finished/i);
  });

  it('preserves the frozen assignment and model policies when guidance restarts an Action', () => {
    const workflowSnapshot = {
      version: 1,
      id: 'policy-workflow',
      name: 'Policy workflow',
      stages: [{
        id: 'analysis-one', name: 'Analysis', type: 'triage', instruction: '', maxAttempts: 2,
        assignmentPolicy: {
          mode: 'pool', capability: 'triage', candidateVpIds: ['omni'], fixedVpId: null,
          separateFromStageTypes: [],
        },
        modelPolicy: { mode: 'specific', model: 'provider/review', effort: 'high' },
      }],
    };
    const item = controller.create(createInput({ workflowTemplate: 'policy-workflow', workflowSnapshot }));
    const claim = store.claimReadyAction('boot-a', 5_000);
    const guided = controller.guide(item.id, {
      guidance: 'Use the frozen policy', actionId: claim.action.id, revision: item.revision,
    });

    expect(guided.actions.at(-1)).toMatchObject({
      stageId: 'analysis-one',
      requiredRole: '',
      assignmentPolicy: workflowSnapshot.stages[0].assignmentPolicy,
      modelPolicy: workflowSnapshot.stages[0].modelPolicy,
      status: 'ready',
    });
  });

  it('rejects guidance when the visible Action or revision is stale', () => {
    const item = controller.create(createInput());
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage'));

    expect(() => controller.guide(item.id, {
      guidance: 'This was intended for triage',
      actionId: triage.action.id,
      revision: item.revision,
    })).toThrow(/Action changed/i);
    expect(store.getWorkItemDetail(item.id).actions.at(-1)).toMatchObject({
      type: 'implement', status: 'ready',
    });
  });

  it('claims a ready Action exactly once and fences stale terminal submissions', () => {
    controller.create(createInput());
    const first = store.claimReadyAction('boot-a', 5_000);
    expect(store.claimReadyAction('boot-b', 5_000)).toBeNull();
    expect(() => controller.submit(first.run.id, 'boot-b', first.run.leaseEpoch, completed('triage')))
      .toThrow(/stale|cancelled|expired|finished/i);
  });

  it('persists immutable execution snapshots only for the fenced Run', () => {
    controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    expect(store.setRunExecutionSnapshots(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      roleSnapshot: { id: 'omni' },
      vpSnapshot: { id: 'omni', name: 'Omni' },
      modelSnapshot: { id: 'provider/model' },
      toolPolicySnapshot: { policyVersion: 1, allowedToolNames: ['FileRead'] },
    })).toBe(true);
    expect(store.setRunExecutionSnapshots(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      roleSnapshot: { id: 'tampered' },
    })).toBe(false);
    expect(store.getRun(claim.run.id)).toMatchObject({
      roleSnapshot: { id: 'omni' },
      vpSnapshot: { id: 'omni', name: 'Omni' },
      modelSnapshot: { id: 'provider/model' },
      toolPolicySnapshot: { policyVersion: 1, allowedToolNames: ['FileRead'] },
    });
  });

  it('advances the finite workflow only after an approved review and deliver', () => {
    const item = controller.create(createInput());
    const expected = ['triage', 'implement', 'review', 'deliver'];
    for (const type of expected) {
      const claim = store.claimReadyAction('boot-a', 5_000);
      expect(claim.action.type).toBe(type);
      const detail = controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed(type));
      expect(detail.status).toBe(type === 'deliver' ? 'done' : 'ready');
    }
    expect(store.getWorkItemDetail(item.id).actions.map(action => action.type)).toEqual(expected);
  });

  it('fails a completed review without an explicit decision', () => {
    controller.create(createInput());
    for (const type of ['triage', 'implement']) {
      const claim = store.claimReadyAction('boot-a', 5_000);
      controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed(type));
    }
    const review = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(review.run.id, 'boot-a', review.run.leaseEpoch, {
      outcome: 'completed', summary: 'looks fine', evidence: [],
    });
    expect(detail.status).toBe('needs_attention');
    expect(detail.actions.at(-1).status).toBe('failed');
    expect(detail.runs.find(run => run.actionId === review.action.id).error).toMatch(/requires approved/i);
  });

  it('returns changes_requested review to a new implement Action with prior context', () => {
    controller.create(createInput());
    for (const type of ['triage', 'implement']) {
      const claim = store.claimReadyAction('boot-a', 5_000);
      controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed(type));
    }
    const review = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(review.run.id, 'boot-a', review.run.leaseEpoch, completed('review', {
      reviewDecision: 'changes_requested', summary: 'One blocking issue', evidence: ['finding'],
    }));
    expect(detail.actions.at(-1).type).toBe('implement');
    expect(detail.actions.at(-1).instruction).toContain('One blocking issue');
    expect(detail.actions.at(-1).instruction).toContain('triage complete');
  });

  it('applies a triage contract patch and hands the refined contract to implement', () => {
    const item = controller.create(createInput());
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      contractPatch: { goal: 'Refined goal', acceptanceCriteria: ['Refined criterion'] },
    }));
    expect(detail.revision).toBe(2);
    expect(detail.goal).toBe('Refined goal');
    expect(detail.actions.at(-1).instruction).toContain('Refined criterion');
    expect(store.getWorkItem(item.id).status).toBe('ready');
  });

  it('records waiting as a terminal Run and resumes with its result and the user answer', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    const waiting = controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      outcome: 'waiting',
      summary: 'Need a choice',
      evidence: [{ kind: 'file', label: 'Configuration', ref: 'config.json', stdout: 'hidden' }],
      waitingReason: 'Choose behavior',
    });
    expect(waiting).toMatchObject({ status: 'waiting', currentRunId: null });
    expect(waiting.runs[0].status).toBe('waiting');
    expect(() => controller.retry(item.id)).toThrow(/answer is required/i);

    const resumed = controller.retry(item.id, { answer: 'Keep the current behavior' });
    const nextAction = resumed.actions.at(-1);
    expect(resumed.actions).toHaveLength(2);
    expect(resumed.status).toBe('ready');
    expect(nextAction.context.at(-1)).toEqual({
      type: 'triage',
      stageId: 'triage',
      vpId: 'omni',
      role: 'omni',
      summary: 'Need a choice',
      evidence: [{ kind: 'file', label: 'Configuration', ref: 'config.json' }],
      waitingReason: 'Choose behavior',
      answer: 'Keep the current behavior',
    });
    expect(nextAction.instruction).toContain('Need a choice');
    expect(nextAction.instruction).toContain('Waiting reason: Choose behavior');
    expect(nextAction.instruction).toContain('User answer: Keep the current behavior');
    expect(nextAction.instruction).toContain('file: Configuration (config.json)');
    expect(JSON.stringify(nextAction)).not.toContain('hidden');
  });

  it('bounds a waiting resume answer and does not require one for needs_attention', () => {
    const waitingItem = controller.create(createInput());
    const waitingClaim = store.claimReadyAction('boot-a', 5_000);
    controller.submit(waitingClaim.run.id, 'boot-a', waitingClaim.run.leaseEpoch, {
      outcome: 'waiting', summary: 'Need input', evidence: [], waitingReason: 'Provide input',
    });
    const longAnswer = `${'a'.repeat(8_000)}discarded`;
    const resumed = controller.retry(waitingItem.id, { answer: longAnswer });
    expect(resumed.actions.at(-1).context.at(-1).answer).toHaveLength(8_000);
    expect(resumed.actions.at(-1).instruction).not.toContain('discarded');

    const failedItem = controller.create(createInput({ title: 'Failed item' }));
    const failedClaim = store.claimReadyAction('boot-a', 5_000);
    controller.submit(failedClaim.run.id, 'boot-a', failedClaim.run.leaseEpoch, {
      outcome: 'failed', summary: 'Permanent failure', evidence: [], error: 'Fix manually',
    });
    const retried = controller.retry(failedItem.id);
    expect(retried.status).toBe('ready');
    expect(retried.actions.at(-1).context.at(-1)).toMatchObject({
      summary: 'Permanent failure',
      answer: null,
    });
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
    expect(store.interruptRun(claim.run.id, 'boot-a', claim.run.leaseEpoch, 'watcher stopped')).toBe(true);
    expect(store.getRun(claim.run.id).status).toBe('interrupted');
    expect(store.getWorkItem(item.id).status).toBe('ready');
    expect(store.claimReadyAction('boot-a', 5_000)?.action.id).toBe(claim.action.id);
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
