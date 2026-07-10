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
    workDir: '/tmp/project',
    start: true,
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
    const item = controller.create(createInput());
    const detail = store.getWorkItemDetail(item.id);

    expect(detail.status).toBe('ready');
    expect(detail.actions).toHaveLength(1);
    expect(detail.actions[0]).toMatchObject({ type: 'triage', requiredRole: 'omni', status: 'ready' });
    expect(detail.events.map(event => event.type)).toContain('work_item.created');
  });

  it('claims a ready Action exactly once and fences stale terminal submissions', () => {
    const item = controller.create(createInput());
    const first = store.claimReadyAction('boot-a', 5_000);
    const second = store.claimReadyAction('boot-b', 5_000);

    expect(first.workItem.id).toBe(item.id);
    expect(first.action.status).toBe('running');
    expect(first.run.leaseEpoch).toBe(1);
    expect(second).toBeNull();

    expect(() => controller.submit(first.run.id, 'boot-b', first.run.leaseEpoch, {
      outcome: 'completed', summary: 'spoofed', evidence: [],
    })).toThrow(/stale|cancelled|already finished/i);
  });

  it('advances the finite role workflow and only finishes after deliver', () => {
    const item = controller.create(createInput());
    const expected = ['triage', 'implement', 'review', 'deliver'];

    for (const type of expected) {
      const claim = store.claimReadyAction('boot-a', 5_000);
      expect(claim.action.type).toBe(type);
      const detail = controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
        outcome: 'completed',
        summary: `${type} complete`,
        evidence: [`${type}-evidence`],
        ...(type === 'review' ? { reviewDecision: 'approved' } : {}),
      });
      expect(detail.status).toBe(type === 'deliver' ? 'done' : 'ready');
    }

    const detail = store.getWorkItemDetail(item.id);
    expect(detail.actions.map(action => action.type)).toEqual(expected);
    expect(detail.currentActionId).toBeNull();
    expect(detail.currentRunId).toBeNull();
  });

  it('returns changes_requested review to a new implement Action', () => {
    controller.create(createInput());
    for (const type of ['triage', 'implement']) {
      const claim = store.claimReadyAction('boot-a', 5_000);
      controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
        outcome: 'completed', summary: type, evidence: [],
      });
    }
    const review = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(review.run.id, 'boot-a', review.run.leaseEpoch, {
      outcome: 'completed',
      reviewDecision: 'changes_requested',
      summary: 'One blocking issue',
      evidence: ['finding'],
    });

    expect(detail.status).toBe('ready');
    expect(detail.actions.at(-1).type).toBe('implement');
    expect(detail.actions.at(-1).sequence).toBe(4);
  });

  it('records waiting as a real terminal Run and resumes with a new Action', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    const waiting = controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      outcome: 'waiting',
      summary: 'Need a product choice',
      evidence: [],
      waitingReason: 'Choose compatibility behavior',
    });

    expect(waiting.status).toBe('waiting');
    expect(waiting.currentRunId).toBeNull();
    expect(waiting.runs[0].status).toBe('waiting');
    expect(waiting.actions[0].status).toBe('completed');

    const resumed = controller.retry(item.id);
    expect(resumed.status).toBe('ready');
    expect(resumed.actions).toHaveLength(2);
    expect(resumed.actions[1].type).toBe('triage');
  });

  it('recovers an expired non-deliver Run but stops deliver for attention', () => {
    const firstItem = controller.create(createInput());
    const firstRun = store.claimReadyAction('old-boot', 10);
    now += 20;
    expect(store.recoverInterruptedRuns('new-boot')).toBe(1);
    expect(store.getWorkItem(firstItem.id).status).toBe('ready');
    expect(store.getRun(firstRun.run.id).status).toBe('interrupted');
    controller.cancel(firstItem.id);

    const deliverItem = controller.create(createInput({ title: 'Deliver release' }));
    const triage = store.claimReadyAction('new-boot', 5_000);
    controller.submit(triage.run.id, 'new-boot', triage.run.leaseEpoch, { outcome: 'completed', summary: '', evidence: [] });
    const implement = store.claimReadyAction('new-boot', 5_000);
    controller.submit(implement.run.id, 'new-boot', implement.run.leaseEpoch, { outcome: 'completed', summary: '', evidence: [] });
    const review = store.claimReadyAction('new-boot', 5_000);
    controller.submit(review.run.id, 'new-boot', review.run.leaseEpoch, { outcome: 'completed', summary: '', evidence: [], reviewDecision: 'approved' });
    const deliver = store.claimReadyAction('old-boot', 10);
    now += 20;
    expect(store.recoverInterruptedRuns('new-boot')).toBe(1);
    expect(store.getWorkItem(deliverItem.id).status).toBe('needs_attention');
    expect(store.getRun(deliver.run.id).status).toBe('interrupted');
  });
});
