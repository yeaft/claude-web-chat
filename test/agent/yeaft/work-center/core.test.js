import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkItemRunner } from '../../../../agent/yeaft/work-center/runner.js';
import { resolvePlanningWorkflowSnapshot } from '../../../../agent/yeaft/work-center/workflow.js';

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

  it('creates an Agent-level WorkItem with a ready triage Action', () => {
    const item = controller.create(createInput({
      origin: { sessionId: 'session-1', messageId: 'message-1', createdBy: 'user' },
      linkedSessionIds: ['session-1'],
    }));
    const detail = store.getWorkItemDetail(item.id);
    expect(detail).toMatchObject({ status: 'ready', executionSchemaVersion: 2, ledgerRevision: 0 });
    expect(detail.actions[0]).toMatchObject({
      type: 'triage', requiredRole: 'omni', status: 'ready', contractRevision: 1,
      generation: 1, specHash: expect.stringMatching(/^[a-f0-9]{64}$/), resultRunId: null,
    });
    expect(detail.origin).toEqual({ sessionId: 'session-1', messageId: 'message-1', createdBy: 'user' });
    expect(detail.linkedSessionIds).toEqual(['session-1']);
    const summary = store.listWorkItems({ sessionId: 'session-1' });
    expect(summary.map(row => row.id)).toEqual([item.id]);
    expect(summary[0]).toMatchObject({
      actionCount: 1,
      completedActionCount: 0,
      currentAction: {
        id: detail.actions[0].id,
        type: 'triage',
        status: 'ready',
        brief: detail.actions[0].brief,
      },
    });
  });

  it('persists, filters, resolves, and deletes plan conflicts', () => {
    const item = controller.create(createInput());
    const action = store.getWorkItemDetail(item.id).actions[0];
    const conflict = store.createPlanConflict(item.id, {
      id: 'conflict-1',
      actionId: action.id,
      generation: 2,
      kind: 'stale-spec',
      details: { expectedSpecHash: 'new', actualSpecHash: 'old' },
    });

    expect(conflict).toMatchObject({
      id: 'conflict-1', actionId: action.id, generation: 2, kind: 'stale-spec', status: 'open',
      details: { expectedSpecHash: 'new', actualSpecHash: 'old' },
      resolvedAt: null,
    });
    expect(store.listPlanConflicts(item.id, { status: 'open' })).toEqual([conflict]);
    expect(store.getWorkItemDetail(item.id).planConflicts).toEqual([conflict]);

    now = 2_000;
    const resolved = store.resolvePlanConflict(conflict.id, { resolution: 'regenerated' });
    expect(resolved).toMatchObject({
      status: 'resolved', details: { resolution: 'regenerated' }, updatedAt: 2_000, resolvedAt: 2_000,
    });
    expect(store.resolvePlanConflict(conflict.id)).toBeNull();
    expect(store.listPlanConflicts(item.id, { status: 'open' })).toEqual([]);
    expect(store.deletePlanConflict(conflict.id)).toBe(true);
    expect(store.getPlanConflict(conflict.id)).toBeNull();
  });

  it('freezes an AI-planned ordered VP assignment and rejects unavailable candidates', () => {
    controller = new WorkflowController(store, { listAvailableVpIds: () => ['linus', 'martin'] });
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'bug-fix', actions: [{
        id: 'fix', type: 'implement', objective: 'Implement the concrete fix',
        candidateVpIds: ['linus', 'martin'], assignmentReason: 'Linus is the primary implementer',
      }] },
    }));
    expect(detail.actions.at(-1).assignmentPolicy).toMatchObject({
      mode: 'planned', candidateVpIds: ['linus', 'martin'], assignmentReason: 'Linus is the primary implementer',
    });

    controller.create(createInput({ id: 'invalid-vp-plan', workflowTemplate: 'ai-planned', workflowSnapshot }));
    const invalid = store.claimReadyAction('boot-a', 5_000);
    const rejected = controller.submit(invalid.run.id, 'boot-a', invalid.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'bug-fix', actions: [{
        id: 'fix', type: 'implement', objective: 'Implement the concrete fix',
        candidateVpIds: ['missing'], assignmentReason: 'Unknown candidate',
      }] },
    }));
    expect(rejected.status).toBe('needs_attention');
    expect(rejected.runs[0].error).toMatch(/unavailable VP/);
  });

  it('freezes an AI-generated WorkItem type and task-specific Action flow after triage', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({
      modelPolicy: { mode: 'specific', model: 'provider/work-center', effort: 'high' },
    });
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned', workflowSnapshot,
    }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: {
        workItemType: 'bug-fix',
        actions: [
          { id: 'diagnose', type: 'research', capability: 'analysis', objective: 'Find the root cause' },
          { id: 'fix', type: 'implement', capability: 'implement', objective: 'Apply the minimal fix' },
          { id: 'verify', type: 'test', capability: 'test', objective: 'Verify acceptance criteria' },
          { id: 'review', type: 'review', capability: 'review', objective: 'Review independently', changesRequestedActionId: 'fix' },
        ],
      },
    }));

    expect(detail.workflowSnapshot).toMatchObject({
      id: 'ai-planned', planningMode: 'ai', workItemType: 'bug-fix',
    });
    expect(detail.workflowSnapshot.stages.map(stage => stage.id))
      .toEqual(['triage', 'diagnose', 'fix', 'verify', 'review']);
    expect(detail.actions[1]).toMatchObject({
      type: 'research', stageId: 'diagnose',
      assignmentPolicy: { mode: 'auto', capability: 'analysis' },
      modelPolicy: { mode: 'specific', model: 'provider/work-center', effort: 'high' },
      status: 'ready',
    });
    expect(detail.actions[1].instruction).toContain('Find the root cause');
    expect(detail.actions.slice(1)).toHaveLength(4);
    expect(item.workflowSnapshot.stages).toHaveLength(1);
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

  it('keeps a graph failed while another Action submits late success', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
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

  it('retries a failed graph Action in place with its dependency and workspace policy', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'retry-graph', actions: [
        { id: 'inspect', type: 'research', objective: 'Inspect', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'fix', type: 'implement', objective: 'Fix', dependsOnActionIds: ['inspect'], workspaceMode: 'isolated-write' },
        { id: 'integrate', type: 'integrate', objective: 'Integrate', dependsOnActionIds: ['fix'], workspaceMode: 'integrate' },
      ] },
    }));
    const inspect = store.claimReadyAction('boot-a', 5_000);
    controller.submit(inspect.run.id, 'boot-a', inspect.run.leaseEpoch, completed('research'));
    const fix = store.claimReadyAction('boot-a', 5_000);
    controller.submit(fix.run.id, 'boot-a', fix.run.leaseEpoch, { outcome: 'failed', error: 'failed', summary: '', evidence: [] });
    const before = store.getWorkItemDetail(fix.workItem.id).actions.length;
    const retried = controller.retry(fix.workItem.id);
    const reset = retried.actions.find(action => action.stageId === 'fix');
    expect(retried.actions).toHaveLength(before);
    expect(reset).toMatchObject({
      id: fix.action.id, status: 'ready', dependsOnStageIds: ['inspect'], workspaceMode: 'isolated-write',
    });
    const retryClaim = store.claimReadyAction('boot-a', 5_000);
    expect(retryClaim.action.id).toBe(fix.action.id);
    controller.submit(retryClaim.run.id, 'boot-a', retryClaim.run.leaseEpoch, completed('implement'));
    expect(store.claimReadyAction('boot-a', 5_000).action.stageId).toBe('integrate');
  });

  it('keeps a waiting graph Action blocked and resumes that exact Action with text and attachments', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'blocked-graph', actions: [
        { id: 'diagnose', type: 'research', objective: 'Diagnose', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'verify', type: 'test', objective: 'Verify', dependsOnActionIds: ['diagnose'], workspaceMode: 'read' },
      ] },
    }));
    const diagnose = store.claimReadyAction('boot-a', 5_000);
    const waiting = controller.submit(diagnose.run.id, 'boot-a', diagnose.run.leaseEpoch, {
      outcome: 'waiting', summary: 'Need the failing sample', evidence: [], waitingReason: 'Attach the sample',
    });

    expect(waiting).toMatchObject({ status: 'waiting', currentActionId: diagnose.action.id });
    expect(waiting.actions.find(action => action.stageId === 'diagnose')).toMatchObject({ status: 'waiting' });
    expect(store.claimReadyAction('boot-a', 5_000)).toBeNull();

    const attachments = [{ fileId: 'file-1', name: 'sample.txt', mimeType: 'text/plain', size: 12 }];
    const input = {
      text: 'Use this sample', actionId: diagnose.action.id, revision: waiting.revision,
      generation: diagnose.action.generation,
      addedAttachmentCount: 1,
      addedAttachments: [{ id: 'file-1', name: 'sample.txt', mimeType: 'text/plain', size: 12, isImage: false }],
      attachments,
    };
    const resumed = controller.input(item.id, input);
    const reset = resumed.actions.find(action => action.stageId === 'diagnose');
    expect(resumed).toMatchObject({
      status: 'ready', currentActionId: diagnose.action.id, revision: waiting.revision + 1, attachments,
    });
    expect(reset).toMatchObject({ id: diagnose.action.id, status: 'ready' });
    expect(reset.context.at(-1)).toMatchObject({
      summary: 'Need the failing sample', waitingReason: 'Attach the sample', answer: 'Use this sample',
    });
    expect(resumed.events.find(event => event.type === 'action.input_added')).toMatchObject({
      actionId: diagnose.action.id,
      data: { text: 'Use this sample', attachments: [{ id: 'file-1', name: 'sample.txt' }] },
    });
    expect(() => controller.input(item.id, input)).toThrow(/Action changed/);
    const afterReplay = store.getWorkItemDetail(item.id);
    expect(afterReplay.revision).toBe(resumed.revision);
    expect(afterReplay.actions).toHaveLength(resumed.actions.length);
    expect(afterReplay.events.filter(event => event.type === 'action.input_added')).toHaveLength(1);
    expect(afterReplay.attachments).toEqual(attachments);

    const guided = controller.input(item.id, {
      text: 'Also inspect parser boundaries', actionId: diagnose.action.id, revision: resumed.revision,
      generation: reset.generation,
      addedAttachmentCount: 0, addedAttachments: [], attachments,
    });
    const guidedAction = guided.actions.find(action => action.stageId === 'diagnose');
    expect(guided).toMatchObject({
      status: 'ready', currentActionId: diagnose.action.id, revision: resumed.revision + 1,
    });
    expect(guided.actions).toHaveLength(resumed.actions.length);
    expect(guidedAction).toMatchObject({
      id: diagnose.action.id, status: 'ready', dependsOnStageIds: [], workspaceMode: 'read',
      contractRevision: diagnose.action.contractRevision,
    });
    expect(guided.actions.find(action => action.stageId === 'verify')).toMatchObject({
      status: 'ready', dependsOnStageIds: ['diagnose'],
    });
    expect(guided.events.find(event => event.type === 'action.input_added'
      && event.data?.text === 'Also inspect parser boundaries')).toMatchObject({
      actionId: diagnose.action.id,
      data: { text: 'Also inspect parser boundaries' },
    });
  });

  it('retries a failed graph Action with attachment-only input and preserves its identity', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'failed-graph', actions: [
        { id: 'implement', type: 'implement', objective: 'Implement', dependsOnActionIds: [], workspaceMode: 'read' },
      ] },
    }));
    const implement = store.claimReadyAction('boot-a', 5_000);
    const failed = controller.submit(implement.run.id, 'boot-a', implement.run.leaseEpoch, {
      outcome: 'failed', error: 'Missing reproduction', summary: 'Cannot reproduce', evidence: [],
    });
    const attachments = [{ fileId: 'file-2', name: 'repro.md', mimeType: 'text/markdown', size: 8 }];
    const retried = controller.input(item.id, {
      text: '', actionId: implement.action.id, revision: failed.revision,
      generation: implement.action.generation,
      addedAttachmentCount: 1,
      addedAttachments: [{ id: 'file-2', name: 'repro.md', mimeType: 'text/markdown', size: 8, isImage: false }],
      attachments,
    });

    expect(retried).toMatchObject({ status: 'ready', currentActionId: implement.action.id, attachments });
    expect(retried.actions.find(action => action.stageId === 'implement')).toMatchObject({
      id: implement.action.id, status: 'ready',
    });
    expect(retried.events.find(event => event.type === 'action.input_added')).toMatchObject({
      actionId: implement.action.id,
      data: { text: 'The user added 1 attachment(s) as additional context for this Action.' },
    });
  });

  it('serializes linear shared workspace writes across WorkItems by canonical identity', () => {
    const firstItem = controller.create(createInput({ title: 'First linear writer' }));
    const secondItem = controller.create(createInput({ title: 'Second linear writer' }));
    const first = store.claimReadyAction('boot-a', 5_000);
    expect(first.workItem.id).toBe(firstItem.id);
    expect(first.action.workspaceMode).toBe('shared');
    expect(store.claimReadyAction('boot-a', 5_000)).toBeNull();
    controller.submit(first.run.id, 'boot-a', first.run.leaseEpoch, completed('triage'));
    expect(store.claimReadyAction('boot-a', 5_000).workItem.id).toBe(secondItem.id);
  });

  it('serializes linear and graph writes across the same canonical workspace', () => {
    const linear = controller.create(createInput({ title: 'Linear writer' }));
    const graphWorkflow = resolvePlanningWorkflowSnapshot({});
    controller.create(createInput({ title: 'Graph writer', workflowTemplate: 'ai-planned', workflowSnapshot: graphWorkflow }));
    const first = store.claimReadyAction('boot-a', 5_000);
    expect(first.workItem.id).toBe(linear.id);
    expect(store.claimReadyAction('boot-a', 5_000)).toBeNull();
  });

  it('serializes shared workspace writes across WorkItems by canonical identity', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const createGraph = title => {
      controller.create(createInput({ title, workflowTemplate: 'ai-planned', workflowSnapshot }));
      const triage = store.claimReadyAction('boot-a', 5_000);
      controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
        plan: { workItemType: 'shared-write', actions: [
          { id: 'write', type: 'implement', objective: 'Write', dependsOnActionIds: [], workspaceMode: 'shared' },
        ] },
      }));
    };
    createGraph('First shared writer');
    createGraph('Second shared writer');
    const first = store.claimReadyAction('boot-a', 5_000);
    expect(first.action.stageId).toBe('write');
    expect(store.claimReadyAction('boot-a', 5_000)).toBeNull();
    controller.submit(first.run.id, 'boot-a', first.run.leaseEpoch, completed('implement'));
    expect(store.claimReadyAction('boot-a', 5_000).action.stageId).toBe('write');
  });

  it('serializes integration against a linear writer in the same canonical workspace', () => {
    const first = store.createWorkItem(createInput({ id: 'linear-writer' }), {
      id: 'linear-action', type: 'implement', stageId: 'implement', workspaceMode: 'shared',
    });
    store.createWorkItem(createInput({ id: 'graph-integration' }), {
      id: 'integration-action', type: 'integrate', stageId: 'integrate', workspaceMode: 'integrate',
    });
    const claim = store.claimReadyAction('boot-a', 5_000);
    expect(claim.workItem.id).toBe(first.id);
    expect(claim.action.workspaceMode).toBe('shared');
    expect(store.claimReadyAction('boot-a', 5_000)).toBeNull();
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

  it('defers cross-WorkItem shared fallback while a read Action runs in the canonical workspace', async () => {
    const readItem = store.createWorkItem(createInput({ id: 'workspace-reader' }), {
      id: 'read-action', type: 'research', stageId: 'read', workspaceMode: 'read',
    });
    const writeItem = store.createWorkItem(createInput({ id: 'workspace-writer' }), {
      id: 'write-action', type: 'implement', stageId: 'write', workspaceMode: 'isolated-write',
    });
    const reader = store.claimReadyAction('boot-a', 5_000);
    const writer = store.claimReadyAction('boot-a', 5_000);
    expect(reader.workItem.id).toBe(readItem.id);
    expect(writer.workItem.id).toBe(writeItem.id);
    const runner = new WorkItemRunner({ store, actionWorktreeRoot: null });

    let prepareError;
    try {
      await runner.prepare({ ...writer, ownerBootId: 'boot-a' });
    } catch (error) {
      prepareError = error;
    }

    expect(prepareError).toMatchObject({ workItemPrepareDeferred: true });
    expect(store.getAction(writer.action.id)).toMatchObject({
      status: 'running', attempt: 1, workspaceMode: 'isolated-write',
    });
    expect(store.isActiveRun(reader.run.id, 'boot-a', reader.run.leaseEpoch)).toBe(true);
  });

  it('serializes a fallback shared Action across WorkItems after isolation fails', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const createGraph = title => {
      controller.create(createInput({ title, workflowTemplate: 'ai-planned', workflowSnapshot }));
      const triage = store.claimReadyAction('boot-a', 5_000);
      controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
        plan: { workItemType: 'fallback-write', actions: [
          { id: 'write', type: 'implement', objective: 'Write', dependsOnActionIds: [], workspaceMode: 'isolated-write' },
          { id: 'integrate', type: 'integrate', objective: 'Integrate', dependsOnActionIds: ['write'], workspaceMode: 'integrate' },
        ] },
      }));
    };
    createGraph('First fallback writer');
    createGraph('Second fallback writer');
    const first = store.claimReadyAction('boot-a', 5_000);
    expect(first.action.workspaceMode).toBe('isolated-write');
    expect(store.claimReadyAction('boot-a', 5_000)).toBeNull();
    store.setActionWorkspace(first.action.id, null, 'shared');
    expect(store.claimReadyAction('boot-a', 5_000)).toBeNull();
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

  it('canonicalizes valid initial plan dependencies and explicit review targets', () => {
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned', workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
    }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: {
        workItemType: 'canonical-plan',
        actions: [
          { id: 'Initial Analysis', type: 'research', objective: 'Analyze the affected implementation', dependsOnActionIds: [] },
          { id: 'Implement Fix', type: 'implement', objective: 'Implement the concrete fix', dependsOnActionIds: ['INITIAL ANALYSIS'] },
          { id: 'Review Fix', type: 'review', objective: 'Review the concrete fix', dependsOnActionIds: ['Implement Fix'], changesRequestedActionId: 'IMPLEMENT FIX' },
        ],
      },
    }));

    expect(detail).toMatchObject({ status: 'ready', planRevision: 1 });
    expect(detail.workflowSnapshot.stages.map(stage => stage.id))
      .toEqual(['triage', 'initial-analysis', 'implement-fix', 'review-fix']);
    expect(detail.workflowSnapshot.stages.find(stage => stage.id === 'implement-fix').dependsOnStageIds)
      .toEqual(['initial-analysis']);
    expect(detail.workflowSnapshot.stages.find(stage => stage.id === 'review-fix')).toMatchObject({
      dependsOnStageIds: ['implement-fix'], changesRequestedStageId: 'implement-fix',
    });
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM plan_audits WHERE work_item_id = ?').get(item.id).count)
      .toBe(1);
  });

  it('preserves a validated domain-specific Action type and applies the custom execution baseline', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({
      globalInstructions: 'Never publish deployment artifacts without explicit approval.',
      actionInstructions: { custom: 'Follow the domain objective and verify the result.' },
    });
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned', workflowSnapshot,
    }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: {
        workItemType: 'incident-response',
        actions: [{
          id: 'threat-model',
          name: 'Threat model',
          type: 'security-assessment',
          capability: 'security',
          objective: 'Assess trust boundaries and produce concrete mitigations',
        }],
      },
    }));

    expect(detail.workflowSnapshot).toMatchObject({
      workItemType: 'incident-response',
      globalInstructions: 'Never publish deployment artifacts without explicit approval.',
    });
    expect(detail.workflowSnapshot.stages.at(-1)).toMatchObject({
      type: 'security-assessment',
      assignmentPolicy: { capability: 'security' },
    });
    expect(detail.actions.at(-1).instruction).toContain('Follow the domain objective and verify the result.');
    expect(detail.actions.at(-1).instruction).toContain('Action type: security-assessment');
    expect(detail.actions.at(-1).instruction).not.toContain('Never publish deployment artifacts without explicit approval.');
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

  it('rejects generic Action-type brief text in an AI-generated plan', () => {
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned', workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
    }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: {
        workItemType: 'bug-fix',
        actions: [{
          id: 'fix',
          type: 'implement',
          objective: 'Fix the Work Center detail failure display',
          approach: 'Follow repository conventions, handle relevant boundaries, and add focused tests while making the change.',
          expectedOutcome: 'The failed Work Item exposes its safe failure reason in detail.',
        }],
      },
    }));

    expect(detail).toMatchObject({ status: 'needs_attention', currentActionId: triage.action.id });
    expect(store.getRun(triage.run.id)).toMatchObject({
      status: 'failed', error: expect.stringMatching(/generic Action-type brief text/i),
    });
    expect(item.workflowSnapshot.stages).toHaveLength(1);
  });

  it('rejects an AI-planned triage result without a specific WorkItem type', () => {
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned', workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
    }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { actions: [{ id: 'fix', type: 'implement', objective: 'Implement the fix' }] },
    }));

    expect(detail).toMatchObject({ status: 'needs_attention', currentActionId: triage.action.id });
    expect(store.getRun(triage.run.id)).toMatchObject({
      status: 'failed', error: expect.stringMatching(/specific workItemType/i),
    });
    expect(item.workflowSnapshot.stages).toHaveLength(1);
  });

  it('rejects an AI-planned triage result that tries to skip the Action plan', () => {
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned',
      workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
    }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(
      triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage'),
    );
    expect(detail).toMatchObject({ status: 'needs_attention', currentActionId: triage.action.id });
    expect(store.getRun(triage.run.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/structured plan/i) });
    expect(item.workflowSnapshot.stages).toHaveLength(1);
  });

  it('requires task-specific Actions even when the inferred type matches a reference workflow', () => {
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned',
      workflowSnapshot: resolvePlanningWorkflowSnapshot({}, 'auto'),
    }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const rejected = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'software-change' },
    }));

    expect(rejected).toMatchObject({ status: 'needs_attention', currentActionId: triage.action.id });
    expect(store.getRun(triage.run.id)).toMatchObject({
      status: 'failed', error: expect.stringMatching(/between 1 and 8 task-specific Actions/i),
    });
    expect(item.workflowSnapshot.stages).toHaveLength(1);
  });

  it('persists AI-generated briefs when the inferred type matches a reference workflow', () => {
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned',
      workflowSnapshot: resolvePlanningWorkflowSnapshot({}, 'auto'),
    }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: {
        workItemType: 'software-change',
        actions: [{
          id: 'fix-folder-picker', type: 'implement',
          objective: 'Restyle the Work Center directory picker and preserve project selection',
          approach: 'Reuse Work Center modal tokens, remove tree-item styling, and add browser coverage',
          expectedOutcome: 'The picker matches the Work Center in both themes and still selects a valid project path',
          dependsOnActionIds: [], workspaceMode: 'shared',
        }],
      },
    }));

    expect(detail.workflowSnapshot).toMatchObject({ workItemType: 'software-change', planningMode: 'ai' });
    expect(detail.workflowSnapshot.stages.map(stage => stage.id)).toEqual(['triage', 'fix-folder-picker']);
    expect(detail.actions.at(-1)).toMatchObject({
      type: 'implement', status: 'ready',
      brief: {
        objective: 'Restyle the Work Center directory picker and preserve project selection',
        approach: 'Reuse Work Center modal tokens, remove tree-item styling, and add browser coverage',
        expectedOutcome: 'The picker matches the Work Center in both themes and still selects a valid project path',
      },
    });
    expect(item.workflowSnapshot.stages).toHaveLength(1);
  });

  it('freezes an explicit Work Item type and rejects a conflicting LLM type', () => {
    const item = controller.create(createInput({
      workflowTemplate: 'ai-planned',
      workflowSnapshot: resolvePlanningWorkflowSnapshot({}, 'incident-response'),
    }));
    expect(item.workflowSnapshot).toMatchObject({ workItemType: 'incident-response' });
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: {
        workItemType: 'software-change',
        actions: [{ id: 'fix', type: 'implement', objective: 'Implement the fix' }],
      },
    }));

    expect(detail).toMatchObject({ status: 'needs_attention' });
    expect(store.getRun(triage.run.id)).toMatchObject({
      status: 'failed', error: expect.stringMatching(/keep the selected workItemType/i),
    });
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

  it('defaults an omitted review return target to the nearest earlier editable Action', () => {
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
          { id: 'verify', type: 'test', objective: 'Verify the change' },
          { id: 'review', type: 'review', objective: 'Review independently' },
        ],
      },
    }));

    expect(detail.workflowSnapshot.stages.find(stage => stage.id === 'review'))
      .toMatchObject({ changesRequestedStageId: 'verify' });
    expect(item.workflowSnapshot.stages).toHaveLength(1);
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

  it('appends fenced input to the same running Action without superseding its Run', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    const updated = controller.input(item.id, {
      text: 'Keep the public API unchanged',
      actionId: claim.action.id,
      revision: item.revision,
      addedAttachmentCount: 0,
      addedAttachments: [],
      attachments: item.attachments,
    });

    expect(updated).toMatchObject({
      id: item.id,
      status: 'running',
      currentActionId: claim.action.id,
      currentRunId: claim.run.id,
      revision: item.revision + 1,
    });
    expect(updated.actions).toHaveLength(1);
    expect(updated.actions[0]).toMatchObject({ id: claim.action.id, status: 'running' });
    expect(store.getRun(claim.run.id)).toMatchObject({ status: 'running' });
    expect(store.listPendingActionInputs(claim.action.id, claim.run.id, 'boot-a', claim.run.leaseEpoch))
      .toEqual([{ id: expect.any(String), text: 'Keep the public API unchanged', attachments: [] }]);
    expect(updated.events.find(event => event.type === 'action.input_added')).toMatchObject({
      actionId: claim.action.id,
      runId: claim.run.id,
      data: { text: 'Keep the public API unchanged', attachments: [] },
    });
    expect(() => controller.input(item.id, {
      text: 'replay', actionId: claim.action.id, revision: item.revision,
    })).toThrow(/Action changed/);
    expect(store.closeRunInput(claim.run.id, 'boot-a', claim.run.leaseEpoch)).toBe(false);
    expect(store.getRun(claim.run.id)).toMatchObject({ status: 'running', acceptingInput: true });
    const [pending] = store.listPendingActionInputs(claim.action.id, claim.run.id, 'boot-a', claim.run.leaseEpoch);
    expect(store.acknowledgeActionInput(pending.id, claim.action.id, claim.run.id, 'boot-a', claim.run.leaseEpoch)).toBe(true);
    expect(store.listPendingActionInputs(claim.action.id, claim.run.id, 'boot-a', claim.run.leaseEpoch)).toEqual([]);
    expect(store.closeRunInput(claim.run.id, 'boot-a', claim.run.leaseEpoch)).toBe(true);
    expect(store.getRun(claim.run.id)).toMatchObject({ acceptingInput: false });
    expect(() => controller.input(item.id, {
      text: 'too late', actionId: claim.action.id, revision: updated.revision,
    })).toThrow(/Action changed/);
  });

  it('accepts fenced input for a running graph Action that is not the WorkItem display pointer', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'parallel-input', actions: [
        { id: 'first', type: 'research', objective: 'Research first', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'second', type: 'design', objective: 'Design second', dependsOnActionIds: [], workspaceMode: 'read' },
      ] },
    }));
    const first = store.claimReadyAction('boot-a', 5_000);
    const second = store.claimReadyAction('boot-b', 5_000);
    expect(store.getWorkItem(item.id).currentActionId).toBe(second.action.id);

    const updated = controller.input(item.id, {
      text: 'Apply this to the first Action', actionId: first.action.id,
      generation: first.action.generation, revision: store.getWorkItem(item.id).revision,
      addedAttachmentCount: 0, addedAttachments: [], attachments: [],
    });

    expect(updated.currentActionId).toBe(second.action.id);
    expect(updated.actions.find(action => action.id === first.action.id)).toMatchObject({ status: 'running' });
    expect(store.getRun(first.run.id)).toMatchObject({ status: 'running' });
    expect(store.listPendingActionInputs(first.action.id, first.run.id, 'boot-a', first.run.leaseEpoch))
      .toEqual([expect.objectContaining({ text: 'Apply this to the first Action' })]);
  });

  it('fans a fenced WorkItem message out to ready and running Actions without restarting them', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'message-scope', actions: [
        { id: 'running', type: 'research', objective: 'Research', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'ready', type: 'design', objective: 'Design', dependsOnActionIds: [], workspaceMode: 'read' },
      ] },
    }));
    const running = store.claimReadyAction('boot-a', 5_000);
    const before = store.getWorkItem(item.id);

    const updated = controller.message(item.id, { text: 'Keep compatibility for every Action', revision: before.revision });

    expect(updated.messages).toEqual([expect.objectContaining({ text: 'Keep compatibility for every Action' })]);
    expect(updated.revision).toBe(before.revision + 1);
    expect(store.getRun(running.run.id)).toMatchObject({ status: 'running' });
    expect(store.listPendingActionInputs(running.action.id, running.run.id, 'boot-a', running.run.leaseEpoch))
      .toEqual([expect.objectContaining({ text: 'WorkItem-level message: Keep compatibility for every Action' })]);
    const ready = updated.actions.find(action => action.status === 'ready');
    expect(ready.instruction).toContain('WorkItem-level user messages');
    expect(ready.instruction).toContain('Keep compatibility for every Action');
    expect(() => controller.message(item.id, { text: 'replay', revision: before.revision }))
      .toThrow(/WorkItem changed/);
  });

  it('rejects a WorkItem message atomically after a running Action closes input', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    expect(store.closeRunInput(claim.run.id, 'boot-a', claim.run.leaseEpoch)).toBe(true);
    const before = store.getWorkItemDetail(item.id);

    expect(() => controller.message(item.id, {
      text: 'Do not acknowledge a message that cannot be delivered',
      revision: before.revision,
    })).toThrow(/closed its input window/);

    const after = store.getWorkItemDetail(item.id);
    expect(after.revision).toBe(before.revision);
    expect(after.messages).toEqual([]);
    expect(after.events.some(event => event.type === 'work_item.message_added')).toBe(false);
    expect(after.events.some(event => event.type === 'work_item.message_applied')).toBe(false);
    expect(store.listPendingActionInputs(claim.action.id, claim.run.id, 'boot-a', claim.run.leaseEpoch)).toEqual([]);
  });

  it('lets a running graph sibling accept scoped input while another Action is waiting', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'mixed-input', actions: [
        { id: 'waiting', type: 'research', objective: 'Wait', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'running', type: 'design', objective: 'Keep running', dependsOnActionIds: [], workspaceMode: 'read' },
      ] },
    }));
    const waiting = store.claimReadyAction('boot-a', 5_000);
    const running = store.claimReadyAction('boot-b', 5_000);
    controller.submit(waiting.run.id, 'boot-a', waiting.run.leaseEpoch, {
      outcome: 'waiting', response: '', summary: 'waiting', evidence: [], waitingReason: 'Need input', acceptanceChecks: [],
    });
    const before = store.getWorkItemDetail(item.id);
    expect(before.status).toBe('waiting');

    const updated = controller.input(item.id, {
      text: 'Only update the running sibling', actionId: running.action.id,
      generation: running.action.generation, revision: before.revision,
      addedAttachmentCount: 0, addedAttachments: [], attachments: [],
    });

    expect(updated.status).toBe('waiting');
    expect(store.getRun(running.run.id)).toMatchObject({ status: 'running' });
    expect(store.listPendingActionInputs(running.action.id, running.run.id, 'boot-b', running.run.leaseEpoch))
      .toEqual([expect.objectContaining({ text: 'Only update the running sibling' })]);
  });

  it('retries a failed graph Action while a sibling Action is still running', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'mixed-retry', actions: [
        { id: 'failed', type: 'research', objective: 'Fail', dependsOnActionIds: [], workspaceMode: 'read', maxAttempts: 1 },
        { id: 'running', type: 'design', objective: 'Keep running', dependsOnActionIds: [], workspaceMode: 'read' },
      ] },
    }));
    const failed = store.claimReadyAction('boot-a', 5_000);
    const running = store.claimReadyAction('boot-b', 5_000);
    controller.submit(failed.run.id, 'boot-a', failed.run.leaseEpoch, {
      outcome: 'failed', response: '', summary: 'failed', evidence: [], error: 'broken', acceptanceChecks: [],
    });
    const before = store.getWorkItemDetail(item.id);
    expect(before.status).toBe('needs_attention');
    expect(before.actions.find(action => action.id === failed.action.id).status).toBe('failed');
    expect(before.actions.find(action => action.id === running.action.id).status).toBe('running');

    const retried = controller.retry(item.id, {
      expected: { actionId: failed.action.id, generation: failed.action.generation, revision: before.revision },
    });

    expect(retried.actions.find(action => action.id === failed.action.id).status).toBe('ready');
    expect(store.getRun(running.run.id).status).toBe('running');
  });

  it('retries a failed graph Action when an earlier sibling keeps the WorkItem waiting', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'mixed-blocked-retry', actions: [
        { id: 'waiting', type: 'research', objective: 'Wait for input', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'failed', type: 'design', objective: 'Fail independently', dependsOnActionIds: [], workspaceMode: 'read', maxAttempts: 1 },
      ] },
    }));
    const waiting = store.claimReadyAction('boot-a', 5_000);
    const failed = store.claimReadyAction('boot-b', 5_000);
    controller.submit(waiting.run.id, 'boot-a', waiting.run.leaseEpoch, {
      outcome: 'waiting', response: 'Need a choice', summary: 'waiting', evidence: [],
      waitingReason: 'Choose A or B', acceptanceChecks: [],
    });
    controller.submit(failed.run.id, 'boot-b', failed.run.leaseEpoch, {
      outcome: 'failed', response: '', summary: 'failed', evidence: [], error: 'broken', acceptanceChecks: [],
    });
    const before = store.getWorkItemDetail(item.id);
    expect(before.status).toBe('waiting');

    const retried = controller.retry(item.id, {
      expected: { actionId: failed.action.id, generation: failed.action.generation, revision: before.revision },
    });

    expect(retried.actions.find(action => action.id === failed.action.id).status).toBe('ready');
    expect(retried.actions.find(action => action.id === waiting.action.id).status).toBe('waiting');
    expect(() => controller.retry(item.id, {
      expected: { actionId: waiting.action.id, generation: waiting.action.generation, revision: retried.revision },
    })).toThrow(/answer or attachments are required/i);
  });

  it('keeps explicit guidance restart semantics for administrative guidance', () => {
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
    for (const value of Object.values(claim.action.brief)) {
      expect(guided.actions[1].instruction).toContain(value);
    }
    expect(guided.actions[1].instruction).toContain('Keep the public API unchanged');
    expect(guided.events.find(event => event.type === 'action.guidance_added')).toMatchObject({
      actionId: guided.actions[1].id,
      data: { guidance: 'Keep the public API unchanged', attachments: [] },
    });
    expect(() => controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed('triage')))
      .toThrow(/stale|cancelled|expired|finished/i);
  });

  it('resumes a waiting Action through fenced input and records the user message', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      outcome: 'waiting', response: 'Need a choice', summary: 'Waiting', evidence: [],
      waitingReason: 'Choose A or B', acceptanceChecks: [],
    });
    const waiting = store.getWorkItemDetail(item.id);
    const resumed = controller.input(item.id, {
      text: 'Choose A', actionId: waiting.currentActionId, revision: waiting.revision,
      addedAttachmentCount: 0, addedAttachments: [], attachments: waiting.attachments,
    });

    expect(resumed.status).toBe('ready');
    expect(resumed.actions.at(-1)).toMatchObject({ type: 'triage', status: 'ready' });
    expect(resumed.events.find(event => event.type === 'action.input_added')).toMatchObject({
      actionId: resumed.currentActionId,
      data: { text: 'Choose A', attachments: [] },
    });
    expect(() => controller.input(item.id, {
      text: 'stale', actionId: waiting.currentActionId, revision: waiting.revision - 1,
    })).toThrow(/Action changed/);
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

  it('persists fenced live response progress and aggregate counts', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    const detail = store.updateRunProgress(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      response: 'Inspecting the existing implementation', loopCount: 2, toolCount: 3,
      llmRequestCount: 3, inputTokens: 240, outputTokens: 60,
      cacheReadTokens: 40, cacheWriteTokens: 10, totalTokens: 350,
      checkpoint: {
        version: 1,
        toolEvents: [{ name: 'FileRead', status: 'completed', resource: 'src/current.js' }],
      },
    });

    expect(detail.runs[0]).toMatchObject({
      response: 'Inspecting the existing implementation', loopCount: 2, toolCount: 3,
      llmRequestCount: 3, inputTokens: 240, outputTokens: 60,
      cacheReadTokens: 40, cacheWriteTokens: 10, totalTokens: 350,
      progressRevision: 2,
      checkpoint: {
        version: 1,
        toolEvents: [{ name: 'FileRead', status: 'completed', resource: 'src/current.js' }],
      },
    });
    expect(store.updateRunProgress(claim.run.id, 'boot-b', claim.run.leaseEpoch, {
      response: 'stale', loopCount: 9, toolCount: 9,
    })).toBeNull();
    expect(store.getRun(claim.run.id).response).toBe('Inspecting the existing implementation');
    expect(item.id).toBe(claim.workItem.id);
  });

  it('rejects completed Action claims without evidence and ordered acceptance checks', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      outcome: 'completed',
      summary: 'Claimed success without proof',
      evidence: [],
      acceptanceChecks: [],
    });

    expect(detail).toMatchObject({ status: 'needs_attention', currentActionId: claim.action.id });
    expect(store.getRun(claim.run.id)).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/concrete evidence/i),
    });
    expect(item.id).toBe(claim.workItem.id);
  });

  it('rejects mismatched acceptance checks even when generic evidence exists', () => {
    controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      outcome: 'completed',
      summary: 'Claimed success with incomplete checks',
      evidence: ['some evidence'],
      acceptanceChecks: [{
        criterion: 'Completed work is completed', status: 'passed', evidence: 'some evidence',
      }],
    });

    expect(detail.status).toBe('needs_attention');
    expect(store.getRun(claim.run.id).error).toMatch(/every acceptance criterion/i);
  });

  it('allows intermediate Actions to defer criteria but requires verification Actions to resolve them', () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    const deferredChecks = createInput().acceptanceCriteria.map(criterion => ({
      criterion, status: 'deferred', evidence: 'scheduled for verification',
    }));
    const planned = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      acceptanceChecks: deferredChecks,
      plan: {
        workItemType: 'verification-task',
        actions: [{ id: 'verify', type: 'test', objective: 'Verify every criterion' }],
      },
    }));
    expect(planned.status).toBe('ready');

    const testClaim = store.claimReadyAction('boot-a', 5_000);
    const rejected = controller.submit(testClaim.run.id, 'boot-a', testClaim.run.leaseEpoch, completed('test', {
      acceptanceChecks: deferredChecks,
    }));
    expect(rejected.status).toBe('needs_attention');
    expect(store.getRun(testClaim.run.id).error).toMatch(/requires every acceptance check to pass/i);
    expect(item.id).toBe(testClaim.workItem.id);
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

  it('validates triage acceptance checks against the proposed contract patch', () => {
    const item = controller.create(createInput());
    const triage = store.claimReadyAction('boot-a', 5_000);
    const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      contractPatch: { acceptanceCriteria: ['Refined criterion'] },
      acceptanceChecks: [{
        criterion: 'Refined criterion', status: 'deferred', evidence: 'scheduled for implement and review',
      }],
    }));
    expect(detail.status).toBe('ready');
    expect(store.getWorkItem(item.id).acceptanceCriteria).toEqual(['Refined criterion']);
  });

  it('aggregates execution stats across retries at Action and WorkItem scope', () => {
    const item = controller.create(createInput());
    const first = store.claimReadyAction('boot-a', 5_000);
    controller.submit(first.run.id, 'boot-a', first.run.leaseEpoch, {
      outcome: 'retryable', summary: '', evidence: [], error: 'retry',
      loopCount: 1, toolCount: 2, llmRequestCount: 2,
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5,
      totalTokens: 135,
    });
    const second = store.claimReadyAction('boot-a', 5_000);
    controller.submit(second.run.id, 'boot-a', second.run.leaseEpoch, completed('triage', {
      loopCount: 2, toolCount: 3, llmRequestCount: 3,
      inputTokens: 200, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 10,
      totalTokens: 270,
    }));

    const detail = store.getWorkItemDetail(item.id);
    const runs = detail.runs.filter(run => run.actionId === first.action.id);
    expect(runs).toHaveLength(2);
    expect(runs.reduce((total, run) => total + run.llmRequestCount, 0)).toBe(5);
    expect(runs.reduce((total, run) => total + run.totalTokens, 0)).toBe(405);
  });

  it('persists the user-facing response and aggregate counts with the completed Run', () => {
    const item = controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed('triage', {
      response: 'Validated scope and prepared the contract.',
      loopCount: 3,
      toolCount: 8,
      llmRequestCount: 4,
      inputTokens: 500,
      outputTokens: 120,
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
      totalTokens: 720,
    }));

    const run = store.getRun(claim.run.id);
    expect(run).toMatchObject({
      response: 'Validated scope and prepared the contract.', loopCount: 3, toolCount: 8,
      llmRequestCount: 4, inputTokens: 500, outputTokens: 120,
      cacheReadTokens: 80, cacheWriteTokens: 20, totalTokens: 720,
      progressRevision: 2,
    });
    expect(store.getWorkItemDetail(item.id).runs[0]).toMatchObject({
      response: 'Validated scope and prepared the contract.', loopCount: 3, toolCount: 8,
      llmRequestCount: 4, inputTokens: 500, outputTokens: 120, totalTokens: 720,
    });
  });

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

  it('persists immutable execution snapshots only for the fenced Run', () => {
    controller.create(createInput());
    const claim = store.claimReadyAction('boot-a', 5_000);
    expect(store.setRunExecutionSnapshots(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      roleSnapshot: { id: 'omni' },
      vpSnapshot: { id: 'omni', name: 'Omni' },
      modelSnapshot: { id: 'provider/model' },
      toolPolicySnapshot: { policyVersion: 1, allowedToolNames: ['FileRead'] },
      contextSnapshot: { contract: { revision: 1 }, dynamic: ['prior result'] },
      executionManifest: { schemaVersion: 2, actionGeneration: 1 },
    })).toBe(true);
    expect(store.setRunExecutionSnapshots(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      roleSnapshot: { id: 'tampered' },
    })).toBe(false);
    expect(store.getRun(claim.run.id)).toMatchObject({
      roleSnapshot: { id: 'omni' },
      vpSnapshot: { id: 'omni', name: 'Omni' },
      modelSnapshot: { id: 'provider/model' },
      toolPolicySnapshot: { policyVersion: 1, allowedToolNames: ['FileRead'] },
      contextSnapshot: { contract: { revision: 1 }, dynamic: ['prior result'] },
      executionManifest: { schemaVersion: 2, actionGeneration: 1 },
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
      acceptanceChecks: [{
        criterion: 'Refined criterion', status: 'deferred', evidence: 'scheduled for implementation',
      }],
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
    expect(() => controller.retry(item.id)).toThrow(/answer or attachments are required/i);

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
    for (const value of Object.values(claim.action.brief)) {
      expect(nextAction.instruction).toContain(value);
    }
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

  it('recovers bounded state across attempts of the same Action only', () => {
    const workflowSnapshot = {
      version: 1,
      id: 'three-attempts',
      name: 'Three attempts',
      stages: [{
        id: 'triage', name: 'Triage', type: 'triage', instruction: 'Triage safely',
        assignmentPolicy: { mode: 'fixed', fixedVpId: 'omni' },
        modelPolicy: { mode: 'inherit' }, maxAttempts: 3,
      }],
    };
    const first = controller.create(createInput({ workflowTemplate: workflowSnapshot.id, workflowSnapshot }));
    const firstClaim = store.claimReadyAction('boot-a', 5_000);
    controller.submit(firstClaim.run.id, 'boot-a', firstClaim.run.leaseEpoch, {
      outcome: 'retryable',
      response: 'Edited important.js before the transient failure',
      summary: '',
      evidence: [],
      error: 'temporary network error',
      checkpoint: {
        version: 1,
        toolEvents: [{ name: 'FileEdit', status: 'completed', resource: 'important.js' }],
      },
    });
    const secondClaim = store.claimReadyAction('boot-a', 5_000);
    expect(store.interruptRun(
      secondClaim.run.id, 'boot-a', secondClaim.run.leaseEpoch, 'stopped before progress',
    )).toBe(true);
    const thirdClaim = store.claimReadyAction('boot-a', 5_000);
    expect(thirdClaim.action.id).toBe(firstClaim.action.id);
    expect(store.getActionResumeContext(firstClaim.action.id, thirdClaim.run.id)).toMatchObject({
      status: 'interrupted',
      error: 'stopped before progress',
      response: 'Edited important.js before the transient failure',
      checkpoint: {
        toolEvents: [{ name: 'FileEdit', status: 'completed', resource: 'important.js' }],
      },
    });

    const unrelated = controller.create(createInput({ title: 'Unrelated item' }));
    expect(store.getActionResumeContext(unrelated.currentActionId, '')).toBeNull();
    expect(first.id).not.toBe(unrelated.id);
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
