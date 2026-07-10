import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
