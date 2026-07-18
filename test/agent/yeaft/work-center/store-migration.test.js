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
      progressRevision: 0, checkpoint: null,
    });
    expect(store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get().value)
      .toBe('12');
    expect(store.getWorkItem('legacy-item').planRevision).toBe(0);
  });
});
