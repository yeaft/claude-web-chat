import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';

describe('Work Center store migration', () => {
  let dir;
  let store;

  afterEach(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('backfills canonical workspace identity for reusable completed v2 work', () => {
    dir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-migration-'));
    const dbPath = join(dir, 'work-center.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES ('schema_version', '2');
      CREATE TABLE work_items (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL, workflow_template TEXT NOT NULL, status TEXT NOT NULL,
        current_action_id TEXT, current_run_id TEXT, work_dir TEXT NOT NULL DEFAULT '', origin TEXT,
        linked_session_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE actions (
        id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, type TEXT NOT NULL, required_role TEXT NOT NULL, instruction TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '[]', contract_revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2, current_run_id TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(work_item_id, sequence)
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, owner_boot_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        ended_at INTEGER, role_snapshot TEXT, vp_snapshot TEXT, model_snapshot TEXT, tool_policy_snapshot TEXT,
        summary TEXT, evidence TEXT NOT NULL DEFAULT '[]', waiting_reason TEXT, error TEXT,
        review_decision TEXT, contract_patch TEXT
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        action_id TEXT, run_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    db.prepare(`INSERT INTO work_items VALUES
      (?, 1, ?, ?, '[]', 'software-change', 'done', NULL, NULL, ?, NULL, '[]', 1, 4)`).run(
      'legacy-item', 'Legacy work', 'Preserve reusable context', dir,
    );
    db.prepare(`INSERT INTO actions VALUES
      (?, ?, 1, 'triage', 'omni', '', '[]', 1, 'completed', 1, 2, NULL, 1, 1, 2)`).run(
      'legacy-action', 'legacy-item',
    );
    db.prepare(`INSERT INTO runs VALUES
      (?, ?, ?, 'old-boot', 1, 'completed', 1, 2, 2, NULL, NULL, NULL, NULL, ?, '[]', NULL, NULL, NULL, NULL)`).run(
      'legacy-run', 'legacy-action', 'legacy-item', 'Legacy reusable decision',
    );
    db.close();

    store = new WorkItemStore(dbPath);

    expect(store.getWorkItem('legacy-item')).toMatchObject({
      workspaceKey: realpathSync(dir),
      attachments: [],
    });
    expect(store.getReusableContext(dir)).toContainEqual(expect.objectContaining({
      type: 'triage',
      summary: 'Legacy reusable decision',
      sourceTitle: 'Legacy work',
    }));
    expect(store.getWorkItemDetail('legacy-item').actions[0]).toMatchObject({
      brief: null, changesRequestedStageId: null,
    });
    expect(store.listActionDependencies('legacy-item', ['triage'])).toHaveLength(1);
    expect(store.getRun('legacy-run')).toMatchObject({
      response: '', loopCount: 0, toolCount: 0, llmRequestCount: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
      progressRevision: 0, checkpoint: null, acceptingInput: true,
    });
    expect(store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value)
      .toBe('15');
    expect(store.getWorkItem('legacy-item')).toMatchObject({
      planRevision: 0,
      executionSchemaVersion: 1,
      ledgerRevision: 0,
    });
    expect(store.getWorkItemDetail('legacy-item').actions[0]).toMatchObject({
      generation: 1,
      specHash: '',
      resultRunId: null,
    });
    expect(store.getRun('legacy-run')).toMatchObject({
      contextSnapshot: null,
      executionManifest: null,
    });
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plan_conflicts'").get())
      .toEqual({ name: 'plan_conflicts' });
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_action_inputs'").get())
      .toEqual({ name: 'pending_action_inputs' });
  });

  it('keeps a schema-12 graph WorkItem claimable on the legacy prompt path', () => {
    dir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-graph-migration-'));
    const dbPath = join(dir, 'work-center.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES ('schema_version', '12');
      CREATE TABLE work_items (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, plan_revision INTEGER NOT NULL DEFAULT 0,
        ledger_revision INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, goal TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL, workflow_template TEXT NOT NULL, workflow_snapshot TEXT,
        status TEXT NOT NULL, current_action_id TEXT, current_run_id TEXT, work_dir TEXT NOT NULL DEFAULT '',
        workspace_key TEXT NOT NULL DEFAULT '', reuse_memory INTEGER NOT NULL DEFAULT 1, origin TEXT,
        linked_session_ids TEXT NOT NULL DEFAULT '[]', session_context TEXT NOT NULL DEFAULT '[]',
        attachments TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE actions (
        id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, type TEXT NOT NULL, required_role TEXT NOT NULL, stage_id TEXT,
        assignment_policy TEXT, model_policy TEXT, depends_on_stage_ids TEXT NOT NULL DEFAULT '[]',
        workspace_mode TEXT NOT NULL DEFAULT 'shared', changes_requested_stage_id TEXT, workspace TEXT,
        instruction TEXT NOT NULL, brief TEXT, context TEXT NOT NULL DEFAULT '[]', contract_revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2,
        current_run_id TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, UNIQUE(work_item_id, sequence)
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE, owner_boot_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        ended_at INTEGER, role_snapshot TEXT, vp_snapshot TEXT, model_snapshot TEXT, tool_policy_snapshot TEXT,
        summary TEXT, evidence TEXT NOT NULL DEFAULT '[]', waiting_reason TEXT, error TEXT, review_decision TEXT,
        contract_patch TEXT, response TEXT NOT NULL DEFAULT '', loop_count INTEGER NOT NULL DEFAULT 0,
        tool_count INTEGER NOT NULL DEFAULT 0, llm_request_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0, progress_revision INTEGER NOT NULL DEFAULT 0, checkpoint TEXT
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        action_id TEXT, run_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    db.prepare(`INSERT INTO work_items VALUES
      (?, 1, 1, 0, ?, ?, '[]', 'software-change', ?, 'ready', ?, NULL, '', '', 1, NULL, '[]', '[]', '[]', 1, 1)`).run(
      'graph-item', 'Legacy graph', 'Remain runnable', JSON.stringify({ executionMode: 'graph' }), 'graph-action',
    );
    db.prepare(`INSERT INTO actions VALUES
      (?, ?, 1, 'triage', 'omni', 'triage', NULL, NULL, '[]', 'shared', NULL, NULL, '', NULL, '[]', 1,
       'ready', 0, 2, NULL, 0, 1, 1)`).run('graph-action', 'graph-item');
    db.close();

    store = new WorkItemStore(dbPath);
    expect(store.getWorkItem('graph-item')).toMatchObject({ executionSchemaVersion: 1, lifecycle: 'active' });
    const claim = store.claimReadyAction('legacy-boot', 5_000);
    expect(claim).toMatchObject({ workItem: { id: 'graph-item', executionSchemaVersion: 1 }, action: { id: 'graph-action' } });
    expect(store.isActiveRun(claim.run.id, 'legacy-boot', claim.run.leaseEpoch)).toBe(true);

    expect(store.closeRunInput(claim.run.id, 'legacy-boot', claim.run.leaseEpoch)).toBe(true);
    store.finalizeRun(claim.run.id, 'legacy-boot', claim.run.leaseEpoch, {
      outcome: 'waiting', summary: 'Need input', waitingReason: 'Choose safely', evidence: [],
    }, () => ({
      actionStatus: 'waiting', workItemStatus: 'waiting', graphAdvance: true, eventType: 'action.waiting',
    }));
    const waiting = store.getWorkItemDetail('graph-item');
    const waitingAction = waiting.actions.find(action => action.id === 'graph-action');
    expect(waiting).toMatchObject({ status: 'waiting', currentActionId: 'graph-action' });

    const retried = store.retryWorkItemAtomic('graph-item', (_workItem, previous) => ({
      type: previous.type,
      stageId: previous.stageId,
      requiredRole: previous.requiredRole,
      assignmentPolicy: previous.assignmentPolicy,
      modelPolicy: previous.modelPolicy,
      dependsOnStageIds: previous.dependsOnStageIds,
      workspaceMode: previous.workspaceMode,
      changesRequestedStageId: previous.changesRequestedStageId,
      instruction: 'Continue with user input',
      brief: previous.brief,
      context: [...previous.context, { type: 'input', summary: 'Proceed safely' }],
      maxAttempts: previous.maxAttempts,
    }), {
      expected: { actionId: waitingAction.id, generation: waitingAction.generation, revision: waiting.revision },
    });
    const replacement = retried.actions.find(action => action.id === 'graph-action');
    expect(replacement).toMatchObject({ status: 'ready', generation: waitingAction.generation + 1 });
    expect(retried.actions.filter(action => action.status === 'waiting')).toHaveLength(0);

    const replacementClaim = store.claimReadyAction('legacy-boot', 5_000);
    expect(replacementClaim.action.id).toBe('graph-action');
    expect(store.closeRunInput(replacementClaim.run.id, 'legacy-boot', replacementClaim.run.leaseEpoch)).toBe(true);
    store.finalizeRun(replacementClaim.run.id, 'legacy-boot', replacementClaim.run.leaseEpoch, {
      outcome: 'completed', summary: 'Done', evidence: [],
    }, () => ({
      actionStatus: 'completed', workItemStatus: 'ready', graphAdvance: true, eventType: 'action.completed',
    }));
    expect(store.getWorkItemDetail('graph-item')).toMatchObject({ status: 'done', currentActionId: null });
  });
});
