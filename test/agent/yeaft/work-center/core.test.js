import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkItemRunner } from '../../../../agent/yeaft/work-center/runner.js';
import { WorkItemCoordinator } from '../../../../agent/yeaft/work-center/coordinator.js';
import { WorkCenterService } from '../../../../agent/yeaft/work-center/service.js';
import {
  buildWorkItemAttachmentContext,
  persistWorkItemAttachments,
} from '../../../../agent/yeaft/work-center/attachments.js';
import { enforceActionRequestDetailBudget } from '../../../../agent/yeaft/work-center/debug-projection.js';
import {
  applyAdditivePlanProposal,
  applyCoordinatorReplan,
} from '../../../../agent/yeaft/work-center/plan-mutation.js';
import { resolvePlanningWorkflowSnapshot } from '../../../../agent/yeaft/work-center/workflow.js';
import {
  MAX_WORK_ITEM_BROWSER_DTO_BYTES,
  projectActionMessagePage,
  projectActionRequestDetail,
  projectActionRequestIndex,
  projectWorkCenterEvent,
  projectWorkItemDetail,
  projectWorkItemSummary,
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


  it('persists Run identity and projects one continuous Action conversation', async () => {
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

    const action = {
      id: 'action-conversation', generation: 2, specHash: 'spec-v2',
      identityHistory: [
        { generation: 1, specHash: 'spec-v1' },
        { generation: 2, specHash: 'spec-v2' },
      ],
    };
    const runs = [
      {
        id: 'run-v1', actionId: action.id, actionGeneration: 1, actionSpecHash: 'spec-v1',
        actionAttempt: 1, status: 'failed', response: 'First execution failed.',
        startedAt: 1_010, endedAt: 1_025, vpSnapshot: { id: 'linus', name: 'Linus' },
      },
      {
        id: 'run-v2', actionId: action.id, actionGeneration: 2, actionSpecHash: 'spec-v2',
        actionAttempt: 1, status: 'completed', response: 'Second execution completed.',
        startedAt: 1_040, endedAt: 1_050, vpSnapshot: { id: 'linus', name: 'Linus' },
      },
      {
        id: 'run-stale', actionId: action.id, actionGeneration: 1, actionSpecHash: 'replaced-spec',
        actionAttempt: 2, status: 'completed', response: 'Stale execution must stay hidden.',
        startedAt: 1_026, endedAt: 1_027, vpSnapshot: { id: 'linus', name: 'Linus' },
      },
    ];
    const events = [
      {
        id: 10, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
        createdAt: 1_030, data: { text: 'Please retry with the corrected constraint.' },
      },
    ];

    const page = projectActionMessagePage(action, runs, events, { limit: 2 });
    expect(page).toMatchObject({ actionId: action.id, generation: 2, total: 3, nextCursor: '1' });
    expect(page.messages.map(message => message.text)).toEqual([
      'Please retry with the corrected constraint.',
      'Second execution completed.',
    ]);
    expect(page.messages.at(-1)).toMatchObject({ generation: 2, attempt: 1 });
    const firstPage = projectActionMessagePage(action, runs, events, { cursor: page.nextCursor, limit: 2 });
    expect(firstPage.messages.map(message => message.text)).toEqual(['First execution failed.']);
    expect(JSON.stringify([firstPage, page])).not.toContain('Stale execution must stay hidden.');

    const requestIndex = projectActionRequestIndex(action, runs.map(run => ({
      run,
      turn: {
        turnId: `turn-${run.id}`,
        openedAt: run.startedAt,
        closedAt: run.endedAt,
        loopCount: 1,
        summaryInputTokens: 10,
        summaryOutputTokens: 5,
        totalTokens: 15,
      },
    })));
    expect(requestIndex.requests.map(request => request.id)).toEqual([
      'turn-run-v2',
      'turn-run-v1',
    ]);
    expect(requestIndex.requests.map(request => request.generation)).toEqual([2, 1]);
    expect(JSON.stringify(requestIndex)).not.toContain('run-stale');
    const orderedRequestIndex = projectActionRequestIndex(action, [
      {
        run: { id: 'run-v1-late', actionId: action.id, actionGeneration: 1, actionSpecHash: 'spec-v1', actionAttempt: 9 },
        turn: { turnId: 'request-v1-late', openedAt: 9_000 },
      },
      {
        run: { id: 'run-v2-attempt-1', actionId: action.id, actionGeneration: 2, actionSpecHash: 'spec-v2', actionAttempt: 1 },
        turn: { turnId: 'request-v2-attempt-1', openedAt: 3_000 },
      },
      {
        run: { id: 'run-v2-attempt-2-old', actionId: action.id, actionGeneration: 2, actionSpecHash: 'spec-v2', actionAttempt: 2 },
        turn: { turnId: 'request-v2-attempt-2-old', openedAt: 1_000 },
      },
      {
        run: { id: 'run-v2-attempt-2-new', actionId: action.id, actionGeneration: 2, actionSpecHash: 'spec-v2', actionAttempt: 2 },
        turn: { turnId: 'request-v2-attempt-2-new', openedAt: 2_000 },
      },
    ]);
    expect(orderedRequestIndex.requests.map(request => request.id)).toEqual([
      'request-v2-attempt-2-new',
      'request-v2-attempt-2-old',
      'request-v2-attempt-1',
      'request-v1-late',
    ]);
    const minimalRequestDetail = enforceActionRequestDetailBudget({
      actionId: action.id,
      generation: action.generation,
      request: {
        id: 'large-request',
        runId: 'large-run',
        status: 'completed',
        model: 'x'.repeat(300 * 1024),
        vp: null,
        openedAt: 1,
        closedAt: 2,
        loopCount: 0,
        totalMs: 1,
        totalTokens: 1,
        loops: [],
      },
    });
    expect(minimalRequestDetail).toMatchObject({
      actionId: action.id,
      generation: action.generation,
      request: { id: 'large-request', truncated: true },
    });

    const identityAction = {
      id: 'identity-boundary', generation: 4, specHash: 'spec-v4',
      identityHistory: [
        { generation: 1, specHash: 'spec-v1' },
        { generation: 2, specHash: 'spec-v2' },
      ],
    };
    const identityPage = projectActionMessagePage(identityAction, [
      { id: 'identity-v1', actionId: identityAction.id, actionGeneration: 1, actionSpecHash: 'spec-v1', status: 'completed', response: 'legal run one', startedAt: 10, endedAt: 11 },
      { id: 'identity-v2', actionId: identityAction.id, actionGeneration: 2, actionSpecHash: 'spec-v2', status: 'completed', response: 'legal run two', startedAt: 20, endedAt: 21 },
      { id: 'identity-v2-stale', actionId: identityAction.id, actionGeneration: 2, actionSpecHash: 'wrong-spec', status: 'completed', response: 'stale same-generation run', startedAt: 22, endedAt: 23 },
      { id: 'identity-v3-orphan', actionId: identityAction.id, actionGeneration: 3, actionSpecHash: 'spec-v3', status: 'completed', response: 'orphan run three', startedAt: 30, endedAt: 31 },
      { id: 'identity-v4', actionId: identityAction.id, actionGeneration: 4, actionSpecHash: 'spec-v4', status: 'completed', response: 'current run four', startedAt: 40, endedAt: 41 },
    ], [
      { id: 1, type: 'action.input_added', actionId: identityAction.id, actionGeneration: 1, createdAt: 5, data: { text: 'legal historical input' } },
      { id: 3, type: 'action.input_added', actionId: identityAction.id, actionGeneration: 3, createdAt: 25, data: { text: 'orphan event three' } },
      { id: 5, type: 'action.input_added', actionId: identityAction.id, actionGeneration: 5, createdAt: 45, data: { text: 'future event five' } },
    ], { limit: 20 });
    expect(identityPage.messages.map(message => message.text)).toEqual([
      'legal historical input', 'legal run one', 'legal run two', 'current run four',
    ]);
    expect(JSON.stringify(identityPage)).not.toMatch(/stale same-generation|orphan|future/);

    const legacyPage = projectActionMessagePage(
      { id: 'legacy-generation-one', generation: 1, specHash: '', identityHistory: [] },
      [{ id: 'legacy-run', actionId: 'legacy-generation-one', actionGeneration: 1, status: 'completed', response: 'legacy response', startedAt: 2, endedAt: 3 }],
      [{ id: 1, type: 'action.input_added', actionId: 'legacy-generation-one', actionGeneration: 1, createdAt: 1, data: { text: 'legacy input' } }],
    );
    expect(legacyPage.messages.map(message => message.text)).toEqual(['legacy input', 'legacy response']);

    const terminalLoopPage = projectActionMessagePage(
      {
        id: 'terminal-loop-order', generation: 1, specHash: 'loop-spec',
        identityHistory: [{ generation: 1, specHash: 'loop-spec' }],
      },
      [{
        id: 'terminal-loop-run', actionId: 'terminal-loop-order', actionGeneration: 1,
        actionSpecHash: 'loop-spec', status: 'completed', response: 'suppressed terminal duplicate',
        startedAt: 90, endedAt: 200,
      }],
      [
        {
          id: 6, type: 'run.loop_output', actionId: 'terminal-loop-order',
          runId: 'terminal-loop-run', actionGeneration: 1, createdAt: 95,
          data: { response: 'terminal loop output' },
        },
        {
          id: 7, type: 'action.input_added', actionId: 'terminal-loop-order',
          actionGeneration: 1, createdAt: 100, data: { text: 'input after running loop' },
        },
      ],
    );
    expect(terminalLoopPage.messages.map(message => message.text)).toEqual([
      'input after running loop', 'terminal loop output',
    ]);
    expect(terminalLoopPage.messages[1]).toMatchObject({
      createdAt: 200, generation: 1, attempt: 1,
    });

    const sameTimeAction = {
      id: 'same-time-runs', generation: 1, specHash: 'same-time-spec',
      identityHistory: [{ generation: 1, specHash: 'same-time-spec' }],
    };
    const sameTimeEvents = [{
      id: 1, type: 'action.input_added', actionId: sameTimeAction.id,
      actionGeneration: 1, createdAt: 50, data: { text: 'same-time input' },
    }];
    const oldSameTimeRun = {
      id: 'z-old', actionId: sameTimeAction.id, actionGeneration: 1,
      actionSpecHash: 'same-time-spec', actionAttempt: 1, status: 'failed',
      response: 'first terminal reply', startedAt: 80, endedAt: 100,
    };
    const newSameTimeRun = {
      id: 'a-new', actionId: sameTimeAction.id, actionGeneration: 1,
      actionSpecHash: 'same-time-spec', actionAttempt: 2, status: 'completed',
      response: 'second terminal reply', startedAt: 90, endedAt: 100,
    };
    const sameTimeFirstPage = projectActionMessagePage(
      sameTimeAction, [oldSameTimeRun], sameTimeEvents, { limit: 1 },
    );
    expect(sameTimeFirstPage).toMatchObject({ nextCursor: '1', total: 2 });
    expect(sameTimeFirstPage.messages.map(message => message.text)).toEqual(['first terminal reply']);
    const sameTimeFinalPage = projectActionMessagePage(
      sameTimeAction, [oldSameTimeRun, newSameTimeRun], sameTimeEvents, { limit: 2 },
    );
    expect(sameTimeFinalPage.messages.map(message => message.text)).toEqual([
      'first terminal reply', 'second terminal reply',
    ]);
    expect(sameTimeFinalPage.messages.map(message => message.attempt)).toEqual([1, 2]);
    const sameTimeOlderPage = projectActionMessagePage(
      sameTimeAction,
      [oldSameTimeRun, newSameTimeRun],
      sameTimeEvents,
      { cursor: sameTimeFirstPage.nextCursor, limit: 2 },
    );
    expect(sameTimeOlderPage.messages.map(message => message.text)).toEqual(['same-time input']);

    const detail = projectWorkItemDetail({
      id: 'work-item-conversation', revision: 1, planRevision: 0, ledgerRevision: 0,
      coordinatorRevision: 0, title: 'Conversation', goal: 'Keep one Action conversation',
      acceptanceCriteria: [], workflowTemplate: 'software-change', status: 'running',
      lifecycle: 'active', attentionState: 'none', currentActionId: action.id,
      actions: [{ ...action, sequence: 1, type: 'implement', status: 'completed' }],
      runs, events, messages: [], attachments: [], createdAt: 1_000, updatedAt: 1_050,
    });
    expect(detail.actions[0].messages.map(message => message.text)).toEqual([
      'First execution failed.',
      'Please retry with the corrected constraint.',
      'Second execution completed.',
    ]);
    expect(detail.actions[0]).not.toHaveProperty('thread');

    const pagedItem = controller.create(createInput({ id: 'conversation-pagination' }));
    const pagedAction = store.getWorkItemDetail(pagedItem.id).actions[0];
    const insertEvent = store.db.prepare(`INSERT INTO events
      (work_item_id, action_id, run_id, action_generation, type, data, created_at)
      VALUES (?, ?, NULL, ?, 'action.input_added', ?, ?)`);
    for (let index = 1; index <= 600; index += 1) {
      insertEvent.run(
        pagedItem.id,
        pagedAction.id,
        pagedAction.generation,
        JSON.stringify({ text: `message-${String(index).padStart(3, '0')}` }),
        10_000 + index * 10,
      );
    }
    store.db.prepare(`INSERT INTO runs
      (id, work_item_id, action_id, owner_boot_id, lease_epoch, status, response,
        action_generation, action_spec_hash, action_attempt, started_at, expires_at, ended_at)
      VALUES (?, ?, ?, 'pagination-review', 1, 'completed', ?, ?, ?, 1, ?, ?, ?)`).run(
      'conversation-pagination-run',
      pagedItem.id,
      pagedAction.id,
      'run-response-300',
      pagedAction.generation,
      pagedAction.specHash,
      12_995,
      13_995,
      13_005,
    );

    const rawDetail = store.getWorkItemDetail(pagedItem.id);
    expect(rawDetail.events).toHaveLength(500);
    const service = new WorkCenterService({
      yeaftDir: dir,
      store,
      controller,
      runner: null,
      ownerBootId: 'pagination-review',
      settingsReader: () => ({}),
    });
    const browserDetail = service.projectBrowserDetail(rawDetail);
    const bodyAction = browserDetail.actions.find(candidate => candidate.id === pagedAction.id);
    await expect(service.handle('get_action_requests', {
      id: pagedItem.id,
      actionId: pagedAction.id,
      generation: pagedAction.generation + 1,
    })).rejects.toThrow('Action generation changed before requests were loaded');
    await expect(service.handle('get_action_request', {
      id: pagedItem.id,
      actionId: pagedAction.id,
      generation: pagedAction.generation + 1,
      runId: 'conversation-pagination-run',
      requestId: 'request-stale-generation',
    })).rejects.toThrow('Action generation changed before request detail was loaded');
    expect(bodyAction.messages).toHaveLength(20);
    expect(bodyAction.messageCount).toBe(601);
    expect(bodyAction.messageCursor).toBe('581');

    const collected = [...bodyAction.messages];
    let cursor = bodyAction.messageCursor;
    while (cursor != null) {
      const pageResult = await service.handle('get_action_messages', {
        id: pagedItem.id,
        actionId: pagedAction.id,
        generation: pagedAction.generation,
        cursor,
        limit: 20,
      });
      collected.unshift(...pageResult.messages);
      cursor = pageResult.nextCursor;
    }
    expect(collected).toHaveLength(601);
    expect(new Set(collected.map(message => message.id)).size).toBe(601);
    expect(collected[0].text).toBe('message-001');
    expect(collected.at(-1).text).toBe('message-600');
    expect(collected.findIndex(message => message.text === 'run-response-300')).toBe(300);

    const cursorDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-cursor-'));
    let cursorNow = 20_000;
    const cursorStore = new WorkItemStore(join(cursorDir, 'work-center.db'), { now: () => cursorNow });
    const cursorController = new WorkflowController(cursorStore);
    const cursorService = new WorkCenterService({
      yeaftDir: cursorDir,
      store: cursorStore,
      controller: cursorController,
      runner: null,
      ownerBootId: 'cursor-review',
      settingsReader: () => ({}),
    });
    try {
      const cursorItem = cursorController.create(createInput({ id: 'conversation-cursor-stability' }));
      const cursorClaim = cursorStore.claimReadyAction('cursor-review', 5_000);
      expect(cursorClaim.workItem.id).toBe(cursorItem.id);
      for (const [text, createdAt] of [
        ['event-one', 20_010],
        ['event-two', 20_100],
        ['event-three', 20_200],
      ]) {
        cursorNow = createdAt;
        cursorStore.appendEvent(cursorItem.id, 'action.input_added', { text }, {
          actionId: cursorClaim.action.id,
          actionGeneration: cursorClaim.action.generation,
        });
      }
      const progressDetail = cursorStore.updateRunProgress(
        cursorClaim.run.id,
        'cursor-review',
        cursorClaim.run.leaseEpoch,
        { response: 'running partial response', loopCount: 1 },
      );
      const progressAction = progressDetail.actions.find(candidate => candidate.id === cursorClaim.action.id);
      const progressPage = projectActionMessagePage(
        progressAction,
        progressDetail.runs,
        cursorStore.listActionEvents(progressAction.id),
        { limit: 2 },
      );
      expect(progressPage).toMatchObject({ total: 3, nextCursor: '1' });
      expect(progressPage.messages.map(message => message.text)).toEqual(['event-two', 'event-three']);
      expect(JSON.stringify(progressPage)).not.toContain('running partial response');
      const progressBrowserDetail = cursorService.projectBrowserDetail(progressDetail);
      const progressBrowserAction = progressBrowserDetail.actions.find(candidate => candidate.id === progressAction.id);
      expect(progressBrowserAction.liveMessage).toMatchObject({
        id: `run:${cursorClaim.run.id}`,
        status: 'running',
        text: 'running partial response',
      });

      cursorNow = 20_300;
      cursorController.submit(
        cursorClaim.run.id,
        'cursor-review',
        cursorClaim.run.leaseEpoch,
        completed(cursorClaim.action.type, { response: 'terminal response' }),
      );
      const olderPage = await cursorService.handle('get_action_messages', {
        id: cursorItem.id,
        actionId: cursorClaim.action.id,
        generation: cursorClaim.action.generation,
        cursor: progressPage.nextCursor,
        limit: 2,
      });
      expect(olderPage).toMatchObject({ total: 4, nextCursor: null });
      expect(olderPage.messages.map(message => message.text)).toEqual(['event-one']);
      expect(new Set([
        ...progressPage.messages.map(message => message.id),
        ...olderPage.messages.map(message => message.id),
      ]).size).toBe(3);
      const refreshedPage = await cursorService.handle('get_action_messages', {
        id: cursorItem.id,
        actionId: cursorClaim.action.id,
        generation: cursorClaim.action.generation,
        limit: 2,
      });
      expect(refreshedPage.messages.map(message => message.text)).toEqual(['event-three', 'terminal response']);
    } finally {
      cursorStore.close();
      rmSync(cursorDir, { recursive: true, force: true });
    }
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
        { id: 'deliver', type: 'deliver', objective: 'Deliver both findings', dependsOnActionIds: ['left', 'right'], workspaceMode: 'shared' },
      ] },
    }));
    const left = store.claimReadyAction('boot-a', 5_000);
    const right = store.claimReadyAction('boot-a', 5_000);
    now = 2_000;
    const failed = controller.submit(left.run.id, 'boot-a', left.run.leaseEpoch, {
      outcome: 'failed', error: 'FIRST FAILURE DETAIL', summary: 'FIRST FAILURE SUMMARY', evidence: [],
    });
    expect(failed.status).toBe('needs_attention');
    const failedAction = failed.actions.find(action => action.id === left.action.id);
    const failedPage = projectActionMessagePage(
      failedAction,
      failed.runs,
      store.listActionEvents(failedAction.id),
    );
    expect(failedPage.messages.map(message => message.text)).toEqual([
      'FIRST FAILURE SUMMARY\n\nFIRST FAILURE DETAIL',
    ]);

    now = 2_100;
    const progressed = controller.submit(
      right.run.id, 'boot-a', right.run.leaseEpoch, completed('research'),
    );
    expect(progressed.actions.find(action => action.stageId === 'right')).toMatchObject({ status: 'completed' });
    expect(store.getWorkItem(failed.id)).toMatchObject({
      status: 'needs_attention', lifecycle: 'active', attentionState: 'failed',
    });

    now = 2_200;
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

    const retriedRun = store.claimReadyAction('boot-a', 5_000);
    expect(retriedRun.action).toMatchObject({
      id: failedAction.id,
      generation: retriedAction.generation,
    });
    now = 3_000;
    const completedRetry = controller.submit(
      retriedRun.run.id,
      'boot-a',
      retriedRun.run.leaseEpoch,
      completed('research', { response: 'SECOND SUCCESS RESPONSE' }),
    );
    store.appendEvent(item.id, 'run.loop_output', {
      response: 'DUPLICATE PARTIAL FAILURE OUTPUT',
    }, {
      actionId: failedAction.id,
      runId: left.run.id,
      actionGeneration: failedAction.generation,
    });
    const completedAction = completedRetry.actions.find(action => action.id === failedAction.id);
    const completedPage = projectActionMessagePage(
      completedAction,
      store.getWorkItemDetail(item.id).runs,
      store.listActionEvents(failedAction.id),
    );
    expect(completedPage.messages.map(message => message.text)).toEqual([
      'FIRST FAILURE SUMMARY\n\nFIRST FAILURE DETAIL',
      'SECOND SUCCESS RESPONSE',
    ]);
    expect(completedPage.messages.filter(message => message.runId === left.run.id)).toHaveLength(1);
    expect(JSON.stringify(completedPage)).not.toContain('DUPLICATE PARTIAL FAILURE OUTPUT');
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
        { id: 'deliver', type: 'deliver', objective: 'Deliver all verified branches', dependsOnActionIds: ['blocked', 'blocker', 'integrate'], workspaceMode: 'shared' },
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
        { id: 'deliver', type: 'deliver', objective: 'Deliver it', dependsOnActionIds: ['review', 'side'] },
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


  it('atomically rejects invalid initial plans, including unsafe final gates', () => {
    const cases = [
    {
      name: 'missing final gate',
      actions: [
        { id: 'verify', type: 'test', objective: 'Verify only part of the contract', dependsOnActionIds: [] },
      ],
      error: /final deliver Action or one terminal review Action/,
    },
    {
      name: 'multiple deliver gates',
      actions: [
        { id: 'deliver-a', type: 'deliver', objective: 'Deliver A', dependsOnActionIds: [] },
        { id: 'deliver-b', type: 'deliver', objective: 'Deliver B', dependsOnActionIds: ['deliver-a'] },
      ],
      error: /multiple deliver Actions/,
    },
    {
      name: 'early parallel deliver',
      actions: [
        { id: 'deliver', type: 'deliver', objective: 'Deliver before validation', dependsOnActionIds: [] },
        { id: 'late-check', type: 'test', objective: 'Validate after delivery', dependsOnActionIds: [] },
      ],
      error: /unique graph sink/,
    },
    {
      name: 'deliver with downstream work',
      actions: [
        { id: 'deliver', type: 'deliver', objective: 'Deliver too early', dependsOnActionIds: [] },
        { id: 'after-deliver', type: 'test', objective: 'Validate after delivery', dependsOnActionIds: ['deliver'] },
      ],
      error: /unique graph sink/,
    },
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
    ];
    for (const { name, actions, error } of cases) {
      const item = controller.create(createInput({
        id: `invalid-${name.replaceAll(' ', '-')}`,
        workflowTemplate: 'ai-planned', workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
      }));
      const triage = store.claimReadyAction('boot-a', 5_000);
      const detail = controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
        plan: { workItemType: 'dangerous-change', actions },
      }));

      expect(detail, name).toMatchObject({ status: 'needs_attention', planRevision: 0 });
      expect(detail.workflowSnapshot.stages.map(stage => stage.id), name).toEqual(['triage']);
      expect(detail.actions, name).toHaveLength(1);
      expect(detail.actions[0], name).toMatchObject({ id: triage.action.id, status: 'failed' });
      expect(detail.runs[0].error, name).toMatch(error);
      expect(store.db.prepare('SELECT COUNT(*) AS count FROM plan_audits WHERE work_item_id = ?').get(item.id).count, name)
        .toBe(0);
    }

    const additiveItem = {
      id: 'additive-gate', planRevision: 1,
      workflowSnapshot: {
        ...resolvePlanningWorkflowSnapshot({}),
        executionMode: 'graph', workItemType: 'additive-gate',
        stages: [
          resolvePlanningWorkflowSnapshot({}).stages[0],
          { id: 'work', name: 'Work', type: 'implement', objective: 'Do work', approach: 'Edit files', expectedOutcome: 'Work complete', assignmentPolicy: { mode: 'auto', capability: 'implement', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] }, modelPolicy: { mode: 'inherit' }, dependsOnStageIds: [], workspaceMode: 'shared', maxAttempts: 2 },
          { id: 'deliver', name: 'Deliver', type: 'deliver', objective: 'Deliver', approach: 'Publish', expectedOutcome: 'Published', assignmentPolicy: { mode: 'auto', capability: 'deliver', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] }, modelPolicy: { mode: 'inherit' }, dependsOnStageIds: ['work'], workspaceMode: 'shared', maxAttempts: 2 },
        ],
      },
    };
    expect(() => applyAdditivePlanProposal({
      workItem: additiveItem,
      actions: [],
      proposal: {
        proposalId: 'after-delivery', basePlanRevision: 1, dependencyPatches: [],
        actions: [{ id: 'late-check', name: 'Late check', type: 'test', objective: 'Validate late', approach: 'Run checks', expectedOutcome: 'Late evidence', dependsOnActionIds: ['deliver'], workspaceMode: 'read' }],
      },
    })).toThrow(/unique graph sink/);
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
          actions: [
            {
              id: 'domain-action',
              type,
              capability: type,
              objective: 'Complete the domain-specific objective',
            },
            {
              id: 'final-review', type: 'review', objective: 'Review the domain-specific result',
              dependsOnActionIds: ['domain-action'], changesRequestedActionId: 'domain-action',
            },
          ],
        },
      }));

      const domainStage = detail.workflowSnapshot.stages.find(stage => stage.id === 'domain-action');
      const domainAction = detail.actions.find(action => action.stageId === 'domain-action');
      expect(domainStage).toMatchObject({ type });
      expect(domainAction.instruction).toContain(customInstruction);
      expect(domainAction.instruction).toContain(`Action type: ${type}`);
      expect(domainAction.instruction).not.toContain('function Object()');
      expect(domainAction.instruction).not.toContain('[object Object]');
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


  it('lets the Coordinator replan unfinished work while preserving completed evidence and fencing late Runs', async () => {
    const workflowSnapshot = resolvePlanningWorkflowSnapshot({});
    const item = controller.create(createInput({ workflowTemplate: 'ai-planned', workflowSnapshot }));
    const triage = store.claimReadyAction('boot-a', 5_000);
    controller.submit(triage.run.id, 'boot-a', triage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'coordinator-replan', actions: [
        { id: 'finished', type: 'research', objective: 'Establish the immutable fact', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'blocked', type: 'test', objective: 'Run an impossible global gate', dependsOnActionIds: ['finished'], workspaceMode: 'read' },
        { id: 'deliver', type: 'deliver', objective: 'Deliver after the gate', dependsOnActionIds: ['blocked'], workspaceMode: 'shared' },
      ] },
    }));
    const finished = store.claimReadyAction('boot-a', 5_000);
    controller.submit(finished.run.id, 'boot-a', finished.run.leaseEpoch, completed('research'));
    const blocked = store.claimReadyAction('boot-a', 5_000);
    const before = store.getWorkItemDetail(item.id);
    let resolveCall;
    const coordinator = new WorkItemCoordinator({
      store,
      runtimeProvider: async () => ({
        config: { primaryModel: 'provider/model', availableModels: [{ id: 'model', ref: 'provider/model', provider: 'provider' }] },
        adapter: { call: () => new Promise(resolve => { resolveCall = resolve; }) },
      }),
      policyProvider: async () => ({ modelPolicy: { mode: 'primary' }, actionModelPolicies: { triage: { effort: 'high' } } }),
      registry: {
        listVps: () => [{ id: 'omni', name: 'Omni', role: 'Requirement Lead', traits: ['triage'] }],
      },
    });
    const turn = coordinator.message(item.id, {
      text: 'Replace the impossible Host gate with code-level validation and keep delivery explicit.',
      revision: before.revision,
      planRevision: before.planRevision,
      ledgerRevision: before.ledgerRevision,
      coordinatorRevision: before.coordinatorRevision,
    });
    expect(turn.detail.messages.at(-1)).toMatchObject({ role: 'assistant', status: 'thinking' });
    expect(turn.detail.messages.at(-1).turnId).toBeTruthy();
    for (let index = 0; index < 10 && !resolveCall; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(resolveCall).toBeTypeOf('function');
    resolveCall({ text: JSON.stringify({
      reply: 'I replaced the impossible gate with a bounded validation Action and kept delivery downstream.',
      decision: {
        kind: 'replan',
        reason: 'The old intermediate test could not prove later review and delivery work.',
        contractPatch: { acceptanceCriteria: ['Code-level validation passes', 'Delivery remains explicit'] },
        guidance: [],
        actions: [
          {
            id: 'blocked', name: 'Validate code gates', type: 'test',
            objective: 'Run code-level validation without claiming unavailable Host proof',
            approach: 'Run focused and repository-wide checks and record residual Host limitations',
            expectedOutcome: 'Code validation is complete and unavailable Host proof remains explicit',
            capability: 'test', candidateVpIds: ['omni'], assignmentReason: 'Use the available validation lead',
            dependsOnActionIds: ['finished'], workspaceMode: 'read',
          },
          {
            id: 'deliver', name: 'Deliver the bounded result', type: 'deliver',
            objective: 'Deliver the verified bounded result',
            approach: 'Recheck the final remote state and publish only verified claims',
            expectedOutcome: 'The WorkItem is delivered with residual limitations recorded',
            capability: 'deliver', candidateVpIds: ['omni'], assignmentReason: 'Use the available delivery lead',
            dependsOnActionIds: ['blocked'], workspaceMode: 'shared',
          },
        ],
      },
    }) });
    const replanned = await turn.task;

    expect(replanned).toMatchObject({
      planRevision: before.planRevision + 1,
      revision: before.revision + 1,
      acceptanceCriteria: ['Code-level validation passes', 'Delivery remains explicit'],
    });
    expect(replanned.messages.at(-1)).toMatchObject({
      role: 'assistant', status: 'completed', decision: { kind: 'replan', changedContract: true },
    });
    const coordinatorTurnId = replanned.messages.at(-1).turnId;
    expect(projectWorkItemDetail(replanned)).toMatchObject({
      coordinatorRevision: replanned.coordinatorRevision,
      planRevision: replanned.planRevision,
      messages: [
        expect.objectContaining({ role: 'user', status: 'completed' }),
        expect.objectContaining({
          role: 'assistant', status: 'completed', decision: expect.objectContaining({ kind: 'replan' }),
        }),
      ],
    });
    expect(projectWorkCenterEvent({ type: 'coordinator.turn_completed', workItem: replanned }).workItem)
      .toMatchObject({ coordinatorRevision: replanned.coordinatorRevision, planRevision: replanned.planRevision });
    expect(replanned.actions.find(action => action.id === finished.action.id)).toMatchObject({ status: 'completed' });
    expect(replanned.actions.find(action => action.id === blocked.action.id)).toMatchObject({ status: 'superseded' });
    expect(replanned.runs.find(run => run.id === blocked.run.id)).toMatchObject({ status: 'superseded' });
    expect(replanned.actions.filter(action => action.status === 'ready').map(action => action.stageId))
      .toEqual(['blocked', 'deliver']);
    expect(replanned.actions.filter(action => action.stageId === 'blocked')).toHaveLength(2);
    expect(store.db.prepare(`SELECT stage_id, COUNT(*) AS count FROM actions WHERE work_item_id = ?
      AND status NOT IN ('superseded', 'cancelled') GROUP BY stage_id HAVING COUNT(*) > 1`).all(item.id))
      .toEqual([]);
    expect(replanned.planConflicts).toHaveLength(0);
    expect(store.db.prepare('SELECT kind, base_plan_revision, plan_revision FROM plan_audits WHERE proposal_id = ?')
      .get(`coordinator:${coordinatorTurnId}`)).toEqual({
        kind: 'coordinator',
        base_plan_revision: before.planRevision,
        plan_revision: before.planRevision + 1,
      });
    expect(() => controller.submit(blocked.run.id, 'boot-a', blocked.run.leaseEpoch, completed('test')))
      .toThrow(/stale|cancelled|expired|finished/i);

    const next = store.getWorkItemDetail(item.id);
    let resolveLate;
    coordinator.runtimeProvider = async () => ({
      config: { primaryModel: 'provider/model', availableModels: [{ id: 'model', ref: 'provider/model', provider: 'provider' }] },
      adapter: { call: () => new Promise(resolve => { resolveLate = resolve; }) },
    });
    const staleTurn = coordinator.message(item.id, {
      text: 'What is happening now?',
      revision: next.revision,
      planRevision: next.planRevision,
      ledgerRevision: next.ledgerRevision,
      coordinatorRevision: next.coordinatorRevision,
    });
    const validation = store.claimReadyAction('boot-a', 5_000);
    controller.submit(validation.run.id, 'boot-a', validation.run.leaseEpoch, completed('test', {
      acceptanceChecks: next.acceptanceCriteria.map(criterion => ({
        criterion, status: 'deferred', evidence: 'Final delivery still remains',
      })),
    }));
    for (let index = 0; index < 10 && !resolveLate; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
    resolveLate({ text: JSON.stringify({
      reply: 'The validation is still running.',
      decision: { kind: 'answer', reason: 'Status question', contractPatch: null, guidance: [], actions: [] },
    }) });
    const fenced = await staleTurn.task;
    expect(fenced.messages.at(-1)).toMatchObject({
      role: 'assistant', status: 'failed', error: expect.stringMatching(/changed while the Coordinator/i),
    });
    expect(store.getWorkItem(item.id).ledgerRevision).toBe(next.ledgerRevision + 1);
    expect(store.claimReadyAction('boot-a', 5_000)?.action.stageId).toBe('deliver');

    const cancellable = controller.create(createInput());
    const cancelBefore = store.getWorkItemDetail(cancellable.id);
    let resolveCancelled;
    coordinator.runtimeProvider = async () => ({
      config: { primaryModel: 'provider/model', availableModels: [{ id: 'model', ref: 'provider/model', provider: 'provider' }] },
      adapter: { call: () => new Promise(resolve => { resolveCancelled = resolve; }) },
    });
    const cancelledTurn = coordinator.message(cancellable.id, {
      text: 'Please change this goal.',
      revision: cancelBefore.revision,
      planRevision: cancelBefore.planRevision,
      ledgerRevision: cancelBefore.ledgerRevision,
      coordinatorRevision: cancelBefore.coordinatorRevision,
    });
    controller.cancel(cancellable.id);
    for (let index = 0; index < 10 && !resolveCancelled; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
    resolveCancelled({ text: JSON.stringify({
      reply: 'I changed the goal.',
      decision: { kind: 'answer', reason: 'Goal request', contractPatch: null, guidance: [], actions: [] },
    }) });
    const cancelledResult = await cancelledTurn.task;
    expect(cancelledResult.messages.at(-1)).toMatchObject({
      role: 'assistant', status: 'failed', error: expect.stringMatching(/changed while the Coordinator/i),
    });
    expect(store.getWorkItem(cancellable.id)).toMatchObject({ status: 'cancelled' });

    const attachmentItem = controller.create(createInput({ id: 'coordinator-attachment' }));
    const attachmentBefore = store.getWorkItemDetail(attachmentItem.id);
    const attachmentRoot = join(dir, 'attachments');
    mkdirSync(attachmentRoot, { recursive: true, mode: 0o700 });
    let attachmentCall;
    const attachmentCoordinator = new WorkItemCoordinator({
      store,
      attachmentRoot,
      runtimeProvider: async () => ({
        config: { primaryModel: 'provider/model', availableModels: [{ id: 'model', ref: 'provider/model', provider: 'provider' }] },
        adapter: { call: async request => {
          attachmentCall = request;
          return { text: JSON.stringify({
            reply: 'The screenshot and note are attached to this WorkItem.',
            decision: { kind: 'answer', reason: 'Attachment context', contractPatch: null, guidance: [], actions: [] },
          }) };
        } },
      }),
      policyProvider: async () => ({ modelPolicy: { mode: 'primary' } }),
      registry: { listVps: () => [{ id: 'omni', name: 'Omni', role: 'Coordinator', traits: ['triage'] }] },
    });
    const attachmentService = new WorkCenterService({
      yeaftDir: dir,
      attachmentRoot,
      store,
      controller,
      coordinator: attachmentCoordinator,
      runner: null,
      ownerBootId: 'coordinator-attachment',
      settingsReader: () => ({}),
    });
    const attachmentAccepted = await attachmentService.handle('work_item_message', {
      id: attachmentItem.id,
      text: 'Use both files.',
      revision: attachmentBefore.revision,
      planRevision: attachmentBefore.planRevision,
      ledgerRevision: attachmentBefore.ledgerRevision,
      coordinatorRevision: attachmentBefore.coordinatorRevision,
      files: [
        { name: 'screen.png', mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') },
        { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('bounded attachment context').toString('base64') },
      ],
    });
    expect(attachmentAccepted).toMatchObject({ accepted: true, turnId: expect.any(String) });
    for (let index = 0; index < 20 && !attachmentCall; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(attachmentCall?.messages?.[0]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image' }),
      expect.objectContaining({ type: 'text', text: expect.stringContaining('bounded attachment context') }),
    ]));
    for (let index = 0; index < 20; index += 1) {
      const latest = store.getWorkItemDetail(attachmentItem.id).messages.at(-1);
      if (latest?.status !== 'thinking') break;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const attachmentDetail = store.getWorkItemDetail(attachmentItem.id);
    expect(attachmentDetail).toMatchObject({ revision: attachmentBefore.revision + 1 });
    expect(attachmentDetail.messages.at(-2)).toMatchObject({
      role: 'user', text: 'Use both files.', attachments: [
        expect.objectContaining({ name: 'screen.png', isImage: true }),
        expect.objectContaining({ name: 'notes.txt', isImage: false }),
      ],
    });
    expect(projectWorkItemDetail(attachmentDetail).messages.at(-2).attachments).toHaveLength(2);

    const boundedContext = (id, contents, byteBudget = 32 * 1024) => {
      const attachments = persistWorkItemAttachments(contents.map((content, index) => ({
        name: `notes-${index + 1}.txt`,
        mimeType: 'text/plain',
        data: Buffer.from(content).toString('base64'),
      })), { root: attachmentRoot, workItemId: id });
      return buildWorkItemAttachmentContext({ id, attachments }, {
        root: attachmentRoot,
        inlineTextBytes: byteBudget,
      }).promptBlock;
    };
    expect(boundedContext('prompt-budget-framing', ['a'], 1)).toBe('');
    let exactContentBytes = 1;
    for (let index = 0; index < 4; index += 1) {
      const measurement = boundedContext(
        `prompt-budget-measure-${index}`,
        ['a'.repeat(exactContentBytes)],
        1024 * 1024,
      );
      const framingBytes = Buffer.byteLength(measurement, 'utf8') - exactContentBytes;
      exactContentBytes = (32 * 1024) - framingBytes;
    }
    const exactBoundary = boundedContext('prompt-budget-exact', ['a'.repeat(exactContentBytes)]);
    const overBoundary = boundedContext('prompt-budget-over', ['a'.repeat(exactContentBytes + 1)]);
    expect(Buffer.byteLength(exactBoundary, 'utf8')).toBe(32 * 1024);
    expect(Buffer.byteLength(overBoundary, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(exactBoundary).not.toContain('[content truncated]');
    expect(overBoundary).toContain('[content truncated]');

    const reviewerLargeEscape = boundedContext('prompt-budget-escape-large', ['&'.repeat(32_768)]);
    const reviewerSmallEscape = boundedContext('prompt-budget-escape-small', ['&'.repeat(6_554)]);
    expect(Buffer.byteLength(reviewerLargeEscape, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(Buffer.byteLength(reviewerSmallEscape, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(reviewerLargeEscape).not.toMatch(/&(?!amp;|lt;|gt;)/);
    expect(reviewerSmallEscape).not.toMatch(/&(?!amp;|lt;|gt;)/);

    const multiFileUnicode = boundedContext('prompt-budget-multi-file', [
      '你🙂&<>'.repeat(100),
      '界🚀&<>'.repeat(100),
      '终点&<>'.repeat(100),
    ]);
    expect(Buffer.byteLength(multiFileUnicode, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(multiFileUnicode).not.toContain('\uFFFD');
    expect(multiFileUnicode.match(/<work-item-attachment-content>/g)).toHaveLength(3);
    expect(multiFileUnicode.match(/<\/work-item-attachment-content>/g)).toHaveLength(3);
    expect(multiFileUnicode).toContain('File: notes-3.txt');
    expect(multiFileUnicode).not.toMatch(/&(?!amp;|lt;|gt;)/);
    const multiFileOverflow = boundedContext('prompt-budget-multi-file-overflow', [
      '&'.repeat(6_554), '&'.repeat(6_554), '&'.repeat(6_554),
    ]);
    expect(Buffer.byteLength(multiFileOverflow, 'utf8')).toBeLessThanOrEqual(32 * 1024);

    expect(() => {
      coordinator.shuttingDown = true;
      coordinator.message(item.id, {
        text: 'This must fail synchronously.',
        revision: next.revision,
        planRevision: next.planRevision,
        ledgerRevision: next.ledgerRevision + 1,
        coordinatorRevision: fenced.coordinatorRevision,
      });
    }).toThrow(/shutting down/i);
  });

  it('preserves execution ownership, recovers durable turns, and schedules same-stage replacements', () => {
    const linear = controller.create(createInput({ id: 'linear-running' }));
    const claimed = store.claimReadyAction('boot-linear', 5_000);
    const before = store.getWorkItemDetail(linear.id);
    const originalInstruction = claimed.action.instruction;
    const answerTurn = store.beginCoordinatorTurn(linear.id, 'Why is this running?', {
      revision: before.revision, planRevision: before.planRevision,
      ledgerRevision: before.ledgerRevision, coordinatorRevision: before.coordinatorRevision,
    });
    const answered = store.completeCoordinatorTurn(answerTurn.turnId, {
      reply: 'The current Action still owns its Run.',
      decision: { kind: 'answer', reason: 'Status question', contractPatch: null, guidance: [], actions: [] },
    }, answerTurn.fence);
    expect(answered).toMatchObject({
      status: 'running', currentActionId: claimed.action.id, currentRunId: claimed.run.id,
    });
    expect(store.isActiveRun(claimed.run.id, 'boot-linear', claimed.run.leaseEpoch)).toBe(true);
    expect(store.getAction(claimed.action.id).instruction).toBe(originalInstruction);
    expect(store.getAction(claimed.action.id).instruction).not.toContain('Why is this running?');
    controller.cancel(linear.id);

    const draft = controller.create(createInput({ id: 'draft-item', start: false }));
    const draftBefore = store.getWorkItemDetail(draft.id);
    const draftTurn = store.beginCoordinatorTurn(draft.id, 'What happens next?', {
      revision: draftBefore.revision, planRevision: draftBefore.planRevision,
      ledgerRevision: draftBefore.ledgerRevision, coordinatorRevision: draftBefore.coordinatorRevision,
    });
    expect(store.completeCoordinatorTurn(draftTurn.turnId, {
      reply: 'Starting creates the first Action.',
      decision: { kind: 'answer', reason: 'Draft question', contractPatch: null, guidance: [], actions: [] },
    }, draftTurn.fence)).toMatchObject({ status: 'draft', currentActionId: null, currentRunId: null });

    const dbPath = join(dir, 'coordinator-reopen.db');
    const persisted = new WorkItemStore(dbPath, { now: () => now });
    const persistedController = new WorkflowController(persisted);
    const persistedItem = persistedController.create(createInput({ id: 'coordinator-reopen' }));
    const persistedBefore = persisted.getWorkItemDetail(persistedItem.id);
    persisted.beginCoordinatorTurn(persistedItem.id, 'Persist this question.', {
      revision: persistedBefore.revision, planRevision: persistedBefore.planRevision,
      ledgerRevision: persistedBefore.ledgerRevision, coordinatorRevision: persistedBefore.coordinatorRevision,
    });
    persisted.close();
    const reopened = new WorkItemStore(dbPath, { now: () => now + 1 });
    try {
      const recovered = reopened.getWorkItemDetail(persistedItem.id);
      expect(recovered.messages.at(-1)).toMatchObject({
        role: 'assistant', status: 'failed', error: expect.stringMatching(/interrupted/i),
      });
      expect(reopened.db.prepare(`SELECT type FROM events WHERE work_item_id = ?
        ORDER BY id DESC LIMIT 1`).get(persistedItem.id)).toEqual({ type: 'coordinator.turn_interrupted' });
      expect(() => reopened.beginCoordinatorTurn(persistedItem.id, 'Continue.', {
        revision: recovered.revision, planRevision: recovered.planRevision,
        ledgerRevision: recovered.ledgerRevision, coordinatorRevision: recovered.coordinatorRevision,
      })).not.toThrow();
    } finally {
      reopened.close();
    }

    const graph = controller.create(createInput({
      id: 'same-stage-replan', workflowTemplate: 'ai-planned', workflowSnapshot: resolvePlanningWorkflowSnapshot({}),
    }));
    const graphTriage = store.claimReadyAction('boot-stage', 5_000);
    controller.submit(graphTriage.run.id, 'boot-stage', graphTriage.run.leaseEpoch, completed('triage', {
      plan: { workItemType: 'same-stage', actions: [
        { id: 'validate', type: 'test', objective: 'Run original validation', dependsOnActionIds: [], workspaceMode: 'read' },
        { id: 'deliver', type: 'deliver', objective: 'Deliver after validation', dependsOnActionIds: ['validate'], workspaceMode: 'shared' },
      ] },
    }));
    const failed = store.claimReadyAction('boot-stage', 5_000);
    controller.submit(failed.run.id, 'boot-stage', failed.run.leaseEpoch, {
      outcome: 'failed', error: 'wrong validation scope', summary: '', evidence: [],
    });
    const graphBefore = store.getWorkItemDetail(graph.id);
    const replanTurn = store.beginCoordinatorTurn(graph.id, 'Keep the stage ids but fix the scope.', {
      revision: graphBefore.revision, planRevision: graphBefore.planRevision,
      ledgerRevision: graphBefore.ledgerRevision, coordinatorRevision: graphBefore.coordinatorRevision,
    });
    const mutation = applyCoordinatorReplan({
      workItem: graphBefore, actions: graphBefore.actions, availableVpIds: [],
      proposal: {
        proposalId: `coordinator:${replanTurn.turnId}`, basePlanRevision: graphBefore.planRevision,
        reason: 'Preserve logical identities.', actions: [
          { id: 'validate', name: 'Validate bounded gates', type: 'test', objective: 'Run bounded validation', approach: 'Run focused checks', expectedOutcome: 'Gates recorded', capability: 'test', candidateVpIds: [], assignmentReason: '', dependsOnActionIds: [], workspaceMode: 'read' },
          { id: 'deliver', name: 'Deliver result', type: 'deliver', objective: 'Deliver only after validation', approach: 'Verify and publish', expectedOutcome: 'Traceable delivery', capability: 'deliver', candidateVpIds: [], assignmentReason: '', dependsOnActionIds: ['validate'], workspaceMode: 'shared' },
        ],
      },
    });
    store.completeCoordinatorTurn(replanTurn.turnId, {
      reply: 'The stage responsibilities are bounded.',
      decision: { kind: 'replan', reason: mutation.reason, contractPatch: null, guidance: [], actions: [] },
      mutation,
    }, replanTurn.fence);
    const replacement = store.claimReadyAction('boot-stage', 5_000);
    expect(replacement.action.stageId).toBe('validate');
    controller.submit(replacement.run.id, 'boot-stage', replacement.run.leaseEpoch, completed('test'));
    expect(store.claimReadyAction('boot-stage', 5_000)?.action.stageId).toBe('deliver');
  });

  it('claims a ready Action exactly once and fences stale terminal submissions', () => {
    controller.create(createInput());
    const first = store.claimReadyAction('boot-a', 5_000);
    expect(store.claimReadyAction('boot-b', 5_000)).toBeNull();
    expect(() => controller.submit(first.run.id, 'boot-b', first.run.leaseEpoch, completed('triage')))
      .toThrow(/stale|cancelled|expired|finished/i);
  });


  it.each([
    ['test', 'done'],
    ['deliver', 'needs_attention'],
  ])(
    'applies the WorkItem-wide acceptance gate at the correct %s boundary',
    (type, expectedStatus) => {
      const targetStage = {
        id: type,
        name: type,
        type,
        instruction: 'Verify the WorkItem contract',
        assignmentPolicy: { mode: 'fixed', fixedVpId: 'omni' },
        modelPolicy: { mode: 'inherit' },
        maxAttempts: 2,
      };
      const stages = [targetStage];
      const workflowSnapshot = {
        version: 1,
        id: `verify-${type}`,
        name: `Verify ${type}`,
        stages,
      };
      controller.create(createInput({ workflowTemplate: workflowSnapshot.id, workflowSnapshot }));
      const claim = store.claimReadyAction('boot-a', 5_000);
      const result = completed(type, {
        acceptanceChecks: createInput().acceptanceCriteria.map(criterion => ({
          criterion, status: 'not_applicable', evidence: 'executor declared this irrelevant',
        })),
      });
      const detail = controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, result);

      expect(detail.status).toBe(expectedStatus);
      if (expectedStatus === 'needs_attention') {
        expect(store.getRun(claim.run.id).error).toMatch(/requires every acceptance check to pass/i);
      } else {
        expect(store.getRun(claim.run.id)).toMatchObject({ status: 'completed', error: null });
      }
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

  it('retriages atomically, fences old Runs, and bounds list/event Action identity', async () => {
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

    for (let revision = 3; revision <= 65; revision += 1) {
      now += 1;
      controller.update(item.id, { goal: `Revision ${revision}` });
    }
    const historicalDetail = store.getWorkItemDetail(item.id);
    expect(historicalDetail.actions).toHaveLength(65);
    expect(historicalDetail.actions.filter(action => action.status === 'superseded')).toHaveLength(64);

    const service = new WorkCenterService({
      yeaftDir: dir,
      store,
      controller,
      runner: null,
      ownerBootId: 'browser-budget',
      settingsReader: () => ({}),
    });
    const listItem = (await service.handle('list', { limit: 100 })).items
      .find(entry => entry.id === item.id);
    const browserEvent = projectWorkCenterEvent({
      type: 'work_item.updated',
      workItem: historicalDetail,
    });
    expect(listItem.actionStats).toHaveLength(1);
    expect(browserEvent.workItem.actionStats.map(action => action.id))
      .toEqual(listItem.actionStats.map(action => action.id));
    expect(listItem).not.toHaveProperty('omittedActionCount');
    expect(browserEvent.workItem).not.toHaveProperty('omittedActionCount');
    expect(Buffer.byteLength(JSON.stringify(listItem), 'utf8'))
      .toBeLessThanOrEqual(MAX_WORK_ITEM_BROWSER_DTO_BYTES);
    expect(Buffer.byteLength(JSON.stringify(browserEvent), 'utf8'))
      .toBeLessThanOrEqual(MAX_WORK_ITEM_BROWSER_DTO_BYTES);

    const oversizedSummary = projectWorkItemSummary({
      ...listItem,
      actionStats: Array.from({ length: 2_000 }, (_, index) => ({
        ...listItem.actionStats[0],
        id: index === 0 ? listItem.currentActionId : `canonical-${index}`,
        contentSummary: 'x'.repeat(512),
      })),
    });
    expect(oversizedSummary).toMatchObject({ truncated: true });
    expect(oversizedSummary).not.toHaveProperty('omittedActionCount');
    expect(oversizedSummary.actionStats).toHaveLength(2_000);
    expect(oversizedSummary.actionStats[0]).toEqual({
      id: listItem.currentActionId,
      generation: listItem.actionStats[0].generation,
      status: listItem.actionStats[0].status,
      progressRevision: listItem.actionStats[0].progressRevision,
      attempt: listItem.actionStats[0].attempt,
    });
    expect(Buffer.byteLength(JSON.stringify(oversizedSummary), 'utf8'))
      .toBeLessThanOrEqual(MAX_WORK_ITEM_BROWSER_DTO_BYTES);
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
