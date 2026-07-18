import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { resolvePlanningWorkflowSnapshot } from '../../../../agent/yeaft/work-center/workflow.js';

const criteria = ['The change is verified'];
function completed(overrides = {}) {
  return {
    outcome: 'completed', summary: 'done', evidence: ['verified'],
    acceptanceChecks: criteria.map(criterion => ({ criterion, status: 'passed', evidence: 'verified' })),
    ...overrides,
  };
}
function plannedAction(id, type, dependsOnActionIds = []) {
  return {
    id, name: id, type, objective: `Complete ${id}`,
    approach: `Inspect repository facts and complete ${id}`,
    expectedOutcome: `${id} is verified`, candidateVpIds: ['linus'],
    assignmentReason: 'Linus is the available executor', dependsOnActionIds, workspaceMode: 'shared',
  };
}

describe('Work Center additive plan mutation', () => {
  let dir;
  let store;
  let controller;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yeaft-plan-mutation-'));
    store = new WorkItemStore(join(dir, 'work-center.db'));
    controller = new WorkflowController(store, { listAvailableVpIds: () => ['linus', 'martin'] });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function createGraph(actions = [
    plannedAction('implement', 'implement'),
    plannedAction('review', 'review', ['implement']),
  ]) {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create({ title: 'Plan task', goal: 'Plan safely', acceptanceCriteria: criteria,
      workflowTemplate: 'ai-planned', workflowSnapshot, workDir: '/tmp', start: true });
    const triage = store.claimReadyAction('boot', 5_000);
    const detail = controller.submit(triage.run.id, 'boot', triage.run.leaseEpoch, completed({
      plan: { workItemType: 'bug-fix', actions },
    }));
    return detail;
  }

  function expandBeforeExistingDownstream(downstreamAction) {
    let detail = createGraph([
      plannedAction('discover', 'research'),
      plannedAction('implement', 'implement', ['discover']),
      downstreamAction,
    ]);
    const discover = store.claimReadyAction('boot', 5_000);
    detail = controller.submit(discover.run.id, 'boot', discover.run.leaseEpoch, completed({
      planProposal: {
        proposalId: `insert-before-${downstreamAction.id}`,
        basePlanRevision: 1,
        actions: [plannedAction('extra', 'diagnose', ['discover'])],
        dependencyPatches: [{
          actionId: detail.actions.find(action => action.stageId === 'implement').id,
          addDependsOnActionIds: ['extra'],
        }],
      },
    }));
    return detail;
  }

  it('atomically appends Actions, patches an unattempted dependency, and audits plan revision', () => {
    let detail = createGraph();
    expect(detail.planRevision).toBe(1);
    expect(detail.workflowSnapshot.executionMode).toBe('graph');
    expect(detail.actions.map(action => action.stageId)).toEqual(['triage', 'implement', 'review']);
    expect(detail.actions.find(action => action.stageId === 'review').assignmentPolicy)
      .toMatchObject({ separateFromStageTypes: ['implement'] });
    const implement = store.claimReadyAction('boot', 5_000);
    detail = controller.submit(implement.run.id, 'boot', implement.run.leaseEpoch, completed({
      planProposal: {
        proposalId: 'proposal-1', basePlanRevision: 1,
        actions: [plannedAction('migration', 'migrate', ['implement'])],
        dependencyPatches: [{ actionId: detail.actions.find(action => action.stageId === 'review').id,
          addDependsOnActionIds: ['migration'] }],
      },
    }));
    expect(detail.planRevision, detail.runs[0]?.error).toBe(2);
    expect(detail.workflowSnapshot.stages.map(stage => stage.id)).toEqual(['triage', 'implement', 'migration', 'review']);
    expect(detail.actions.find(action => action.stageId === 'review').dependsOnStageIds).toEqual(['implement', 'migration']);
    expect(detail.actions.find(action => action.stageId === 'migration').status).toBe('ready');
    expect(detail.events[0]).toMatchObject({ type: 'workflow.plan_expanded', data: {
      proposalId: 'proposal-1', previousPlanRevision: 1, planRevision: 2,
    } });
    expect(store.db.prepare('SELECT * FROM plan_audits WHERE work_item_id = ? ORDER BY id').all(detail.id))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        proposal_id: 'proposal-1', base_plan_revision: 1, plan_revision: 2, kind: 'expand',
      })]));
  });

  it('stably inserts a new dependency before a patched Action with a review downstream', () => {
    const detail = expandBeforeExistingDownstream(
      plannedAction('review', 'review', ['implement']),
    );
    expect(detail.status).toBe('ready');
    expect(detail.planRevision, detail.runs[0]?.error).toBe(2);
    expect(detail.workflowSnapshot.stages.map(stage => stage.id))
      .toEqual(['triage', 'discover', 'extra', 'implement', 'review']);
    expect(detail.actions.find(action => action.stageId === 'implement').dependsOnStageIds)
      .toEqual(['discover', 'extra']);
    expect(detail.actions.find(action => action.stageId === 'review').status).toBe('ready');
  });

  it('stably inserts a new dependency before a patched Action with a normal downstream', () => {
    const detail = expandBeforeExistingDownstream(
      plannedAction('verify', 'test', ['implement']),
    );
    expect(detail.status).toBe('ready');
    expect(detail.planRevision, detail.runs[0]?.error).toBe(2);
    expect(detail.workflowSnapshot.stages.map(stage => stage.id))
      .toEqual(['triage', 'discover', 'extra', 'implement', 'verify']);
    expect(detail.actions.find(action => action.stageId === 'implement').dependsOnStageIds)
      .toEqual(['discover', 'extra']);
    expect(detail.actions.find(action => action.stageId === 'verify').status).toBe('ready');
  });

  it('inserts a replan barrier, preserves completed history, and fences unfinished siblings', () => {
    let detail = createGraph();
    const implement = store.claimReadyAction('boot', 5_000);
    detail = controller.submit(implement.run.id, 'boot', implement.run.leaseEpoch, completed({
      replanRequest: {
        proposalId: 'replan-1', basePlanRevision: 1,
        reason: 'The discovered contract requires replacing the unfinished topology',
      },
    }));
    expect(detail.planRevision).toBe(2);
    expect(detail.actions.find(action => action.stageId === 'implement').status).toBe('completed');
    expect(detail.actions.find(action => action.stageId === 'review').status).toBe('superseded');
    expect(detail.actions.at(-1)).toMatchObject({ stageId: 'replan-2', type: 'triage', status: 'ready' });
    expect(detail.events[0]).toMatchObject({ type: 'workflow.replan_requested', data: {
      proposalId: 'replan-1', previousPlanRevision: 1, planRevision: 2,
    } });
  });

  it('rejects replan Actions that reuse any historical stage identity', () => {
    let detail = createGraph();
    const implement = store.claimReadyAction('boot', 5_000);
    detail = controller.submit(implement.run.id, 'boot', implement.run.leaseEpoch, completed({
      replanRequest: {
        proposalId: 'replan-reuse', basePlanRevision: 1,
        reason: 'Replace unfinished work without rewriting completed history',
      },
    }));
    const replan = store.claimReadyAction('boot', 5_000);
    const rejected = controller.submit(replan.run.id, 'boot', replan.run.leaseEpoch, completed({
      plan: { workItemType: 'bug-fix', actions: [
        plannedAction('implement', 'implement'),
        plannedAction('review-next', 'review', ['implement']),
      ] },
    }));
    expect(rejected.status).toBe('needs_attention');
    expect(rejected.runs[0].error).toMatch(/reuses historical stage identity: implement/);
    expect(rejected.actions.find(action => action.stageId === 'implement').status).toBe('completed');
    expect(rejected.actions.filter(action => action.stageId === 'implement')).toHaveLength(1);
    expect(detail.actions.find(action => action.stageId === 'implement').status).toBe('completed');
  });

  it('canonicalizes additive Action identities before persistence and dependency matching', () => {
    let detail = createGraph();
    const implement = store.claimReadyAction('boot', 5_000);
    detail = controller.submit(implement.run.id, 'boot', implement.run.leaseEpoch, completed({
      planProposal: {
        proposalId: 'canonical-action', basePlanRevision: 1,
        actions: [plannedAction('Extra Work', 'test', ['IMPLEMENT'])],
      },
    }));
    expect(detail.planRevision, detail.runs[0]?.error).toBe(2);
    expect(detail.workflowSnapshot.stages.map(stage => stage.id))
      .toEqual(['triage', 'implement', 'review', 'extra-work']);
    expect(detail.actions.filter(action => action.stageId === 'extra-work')).toHaveLength(1);
    expect(detail.actions.find(action => action.stageId === 'extra-work')).toMatchObject({
      status: 'ready', dependsOnStageIds: ['implement'],
    });
    const review = store.claimReadyAction('boot', 5_000);
    expect(review.action.stageId).toBe('review');
    controller.submit(review.run.id, 'boot', review.run.leaseEpoch, completed({ reviewDecision: 'approved' }));
    expect(store.claimReadyAction('boot', 5_000)?.action.stageId).toBe('extra-work');
  });

  it('atomically rejects additive Action identities that collide after canonicalization', () => {
    const detail = createGraph();
    const implement = store.claimReadyAction('boot', 5_000);
    const rejected = controller.submit(implement.run.id, 'boot', implement.run.leaseEpoch, completed({
      planProposal: {
        proposalId: 'canonical-collision', basePlanRevision: 1,
        actions: [
          plannedAction('Extra Work', 'test', ['implement']),
          plannedAction('extra@work', 'document', ['implement']),
        ],
      },
    }));
    expect(rejected.status).toBe('needs_attention');
    expect(rejected.planRevision).toBe(1);
    expect(rejected.actions.some(action => action.stageId === 'extra-work')).toBe(false);
    expect(rejected.runs[0].error).toMatch(/already exists: extra-work/);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM plan_audits WHERE proposal_id = 'canonical-collision'").get().count)
      .toBe(0);
    expect(detail.actions).toHaveLength(3);
  });

  it('atomically rejects duplicate dependency patch targets', () => {
    const detail = createGraph();
    const implement = store.claimReadyAction('boot', 5_000);
    const reviewId = detail.actions.find(action => action.stageId === 'review').id;
    const rejected = controller.submit(implement.run.id, 'boot', implement.run.leaseEpoch, completed({
      planProposal: {
        proposalId: 'duplicate-patch', basePlanRevision: 1,
        actions: [
          plannedAction('migration', 'migrate', ['implement']),
          plannedAction('verification', 'test', ['implement']),
        ],
        dependencyPatches: [
          { actionId: reviewId, addDependsOnActionIds: ['migration'] },
          { actionId: reviewId, addDependsOnActionIds: ['verification'] },
        ],
      },
    }));
    expect(rejected.status).toBe('needs_attention');
    expect(rejected.planRevision).toBe(1);
    expect(rejected.actions.some(action => ['migration', 'verification'].includes(action.stageId))).toBe(false);
    expect(rejected.actions.find(action => action.stageId === 'review').dependsOnStageIds).toEqual(['implement']);
    expect(rejected.runs[0].error).toMatch(/dependency patch target is duplicated/);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM plan_audits WHERE proposal_id = 'duplicate-patch'").get().count)
      .toBe(0);
  });

  it.each([
    {
      name: 'Action dependency',
      proposalId: 'invalid-dependency-ref',
      actions: [plannedAction('dangerous followup', 'operate', ['@@@'])],
      dependencyPatches: [],
      error: /dependencies contains an invalid Action reference/,
    },
    {
      name: 'review target',
      proposalId: 'invalid-review-ref',
      actions: [{
        ...plannedAction('followup review', 'review', ['implement']),
        changesRequestedActionId: '   ',
      }],
      dependencyPatches: [],
      error: /review target contains an (?:empty|invalid) Action reference/,
    },
    {
      name: 'dependency patch reference',
      proposalId: 'invalid-patch-ref',
      actions: [plannedAction('followup test', 'test', ['implement'])],
      dependencyPatches: 'invalid',
      error: /dependency patch contains an (?:empty|invalid) Action reference/,
    },
  ])('atomically rejects a canonical-empty $name', ({ proposalId, actions, dependencyPatches, error }) => {
    const before = createGraph();
    const implement = store.claimReadyAction('boot', 5_000);
    const reviewId = before.actions.find(action => action.stageId === 'review').id;
    const rejected = controller.submit(implement.run.id, 'boot', implement.run.leaseEpoch, completed({
      planProposal: {
        proposalId,
        basePlanRevision: 1,
        actions,
        dependencyPatches: dependencyPatches === 'invalid'
          ? [{ actionId: reviewId, addDependsOnActionIds: [''] }]
          : dependencyPatches,
      },
    }));
    expect(rejected.status).toBe('needs_attention');
    expect(rejected.planRevision).toBe(1);
    expect(rejected.workflowSnapshot).toEqual(before.workflowSnapshot);
    expect(rejected.actions.map(action => ({
      stageId: action.stageId,
      dependsOnStageIds: action.dependsOnStageIds,
    }))).toEqual(before.actions.map(action => ({
      stageId: action.stageId,
      dependsOnStageIds: action.dependsOnStageIds,
    })));
    expect(rejected.actions.find(action => action.stageId === 'implement').status).toBe('failed');
    expect(rejected.runs[0].error).toMatch(error);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM plan_audits WHERE proposal_id = ?').get(proposalId).count)
      .toBe(0);
  });

  it('rejects stale revisions without applying any expansion', () => {
    const detail = createGraph();
    const implement = store.claimReadyAction('boot', 5_000);
    const rejected = controller.submit(implement.run.id, 'boot', implement.run.leaseEpoch, completed({
      planProposal: { proposalId: 'stale', basePlanRevision: 0,
        actions: [plannedAction('migration', 'migrate', ['implement'])] },
    }));
    expect(rejected.status).toBe('needs_attention');
    expect(rejected.planRevision).toBe(1);
    expect(rejected.actions.some(action => action.stageId === 'migration')).toBe(false);
    expect(rejected.runs[0].error).toMatch(/stale basePlanRevision/);
    expect(detail.actions).toHaveLength(3);
  });
});
