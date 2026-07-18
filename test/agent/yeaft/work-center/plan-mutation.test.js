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

  function createGraph() {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create({ title: 'Plan task', goal: 'Plan safely', acceptanceCriteria: criteria,
      workflowTemplate: 'ai-planned', workflowSnapshot, workDir: '/tmp', start: true });
    const triage = store.claimReadyAction('boot', 5_000);
    const detail = controller.submit(triage.run.id, 'boot', triage.run.leaseEpoch, completed({
      plan: { workItemType: 'bug-fix', actions: [
        plannedAction('implement', 'implement'),
        plannedAction('review', 'review', ['implement']),
      ] },
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
